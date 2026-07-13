import {
  createJob,
  resumeRun,
  WorkerLeaseConflictError,
  type IssueNumber,
  type JobId,
  type RunId,
  type Run,
  type WorkerId,
} from '@ai-sdlc/domain';
import type { RunRepositoryPort } from './ports.js';
import type { JobQueuePort, WorkerLeasePort } from './ports/index.js';
import type { EventBusPort } from './ports/event-bus-port.js';
import type { LoggerPort } from './ports/logger-port.js';
import type { SweepOrphanedRunEntry } from './sweep-orphaned-runs.js';

const ORPHAN_RECOVERY_JOB_PRIORITY = 10;
const LEASE_TTL_MS = 30_000;

export interface OrphanedRunsSweeperDeps {
  runRepository: RunRepositoryPort;
  leases: WorkerLeasePort;
  queue: JobQueuePort;
  eventBus: EventBusPort;
  now: () => Date;
  logger: LoggerPort;
}

export interface OrphanedRunsSweeperResult {
  scanned: number;
  enqueued: number;
  skippedLeaseConflict: number;
  skippedAlreadyQueued: number;
  enqueueErrors: Array<{ runId: string; error: string }>;
}

export class OrphanedRunsSweeper {
  constructor(private readonly deps: OrphanedRunsSweeperDeps) {}

  async execute(entries: SweepOrphanedRunEntry[]): Promise<OrphanedRunsSweeperResult> {
    const result: OrphanedRunsSweeperResult = {
      scanned: entries.length,
      enqueued: 0,
      skippedLeaseConflict: 0,
      skippedAlreadyQueued: 0,
      enqueueErrors: [],
    };

    // Snapshot active jobs once so the per-entry idempotency check is
    // O(1) instead of an O(N) query per entry.
    const activeRuns = new Set<RunId>();
    for (const job of this.deps.queue.listActive()) {
      activeRuns.add(job.runId);
    }

    for (const entry of entries) {
      const run = entry.run;

      // Lease guard: a live worker holds the lease for this repo. Skip -
      // the drain loop will pick up the run when the worker eventually
      // finishes or the lease expires.
      if (this.deps.leases.checkActiveLease(run.repoId, this.deps.now())) {
        result.skippedLeaseConflict++;
        this.deps.logger.error(
          `OrphanedRunsSweeper: Active lease for repo ${run.repoId}, skipping ${run.uuid}`,
        );
        this.restoreRunToPreSweep(entry, 'skippedLeaseConflict');
        continue;
      }

      // Idempotency: another sweeper tick (or the same tick in another
      // process) already enqueued a job for this run.
      if (activeRuns.has(run.uuid as RunId)) {
        result.skippedAlreadyQueued++;
        this.restoreRunToPreSweep(entry, 'skippedAlreadyQueued');
        continue;
      }

      let leaseAcquired = false;
      try {
        this.deps.leases.acquire({
          repoId: run.repoId,
          workerId: 'orphan-sweeper' as unknown as WorkerId,
          runId: run.uuid as RunId,
          now: this.deps.now(),
          ttlMs: LEASE_TTL_MS,
        });
        leaseAcquired = true;
      } catch (err) {
        if (err instanceof WorkerLeaseConflictError) {
          result.skippedLeaseConflict++;
          this.deps.logger.error(
            `OrphanedRunsSweeper: Lease conflict for run ${run.uuid}, skipping: ${err.message}`,
          );
          this.restoreRunToPreSweep(entry, 'leaseConflict');
        } else {
          result.enqueueErrors.push({
            runId: run.uuid,
            error: err instanceof Error ? err.message : String(err),
          });
          this.deps.logger.error(
            `OrphanedRunsSweeper: Failed to acquire lease for run ${run.uuid}:`,
            err,
          );
          this.restoreRunToPreSweep(entry, 'leaseAcquireError');
        }
        continue;
      }

      const expectedStatus = run.status; // 'failed' from SweepOrphanedRuns
      try {
        // Atomically transition failed -> running. resumeRun clears
        // completedAt / failureReason and preserves completedPhases +
        // skippedPhases so the worker picks up at the right point.
        const next = resumeRun(run as Run);
        const updated = this.deps.runRepository.atomicUpdateByUuid(
          run.uuid,
          {
            status: next.status,
            completedAt: null,
            failureReason: null,
            currentPhase: null,
          },
          expectedStatus,
        );
        if (!updated) {
          this.deps.logger.error(
            `OrphanedRunsSweeper: run ${run.uuid} status changed concurrently (expected ${expectedStatus}), skipping`,
          );
          continue;
        }

        try {
          const job = createJob({
            id: `orphan-${run.uuid}-${this.deps.now().getTime()}` as JobId,
            runId: run.uuid as RunId,
            repoId: run.repoId,
            issueNumber: run.issueNumber as IssueNumber,
            priority: ORPHAN_RECOVERY_JOB_PRIORITY,
            createdAt: this.deps.now(),
          });

          this.deps.eventBus.publish(run.uuid, {
            runId: run.uuid,
            level: 'info',
            type: 'orchestrator.run.recovered_from_orphan',
            message: `Run recovered from orphaned pid ${entry.previousPid}`,
            timestamp: this.deps.now().toISOString(),
            metadata: { previousPid: entry.previousPid },
          });

          this.deps.queue.enqueue({ job });

          result.enqueued++;
        } catch (err) {
          this.deps.logger.error(
            `OrphanedRunsSweeper: Enqueue failed for run ${run.uuid}, rolling back:`,
            err,
          );
          this.restoreRunToPreSweepAtomic(entry, 'enqueueError');
          throw err;
        }
      } catch (err) {
        result.enqueueErrors.push({
          runId: run.uuid,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (leaseAcquired) {
          try {
            this.deps.leases.release({
              repoId: run.repoId,
              workerId: 'orphan-sweeper' as unknown as WorkerId,
              runId: run.uuid as RunId,
            });
          } catch (relErr) {
            this.deps.logger.error(
              `OrphanedRunsSweeper: Failed to release lease on completion for ${run.uuid}:`,
              relErr,
            );
          }
        }
      }
    }

    return result;
  }

  // Restore the run's status from `failed` (set by SweepOrphanedRuns) back to
  // its pre-sweep status. Used on every path where the sweeper decides not to
  // (or cannot) enqueue a resume job, so `findActiveRuns()` will return the
  // run on the next sweep tick.
  private restoreRunToPreSweep(
    entry: SweepOrphanedRunEntry,
    reason: 'skippedLeaseConflict' | 'skippedAlreadyQueued' | 'leaseConflict' | 'leaseAcquireError',
  ): void {
    try {
      this.deps.runRepository.atomicUpdateByUuid(
        entry.uuid,
        {
          status: entry.previousStatus,
          completedAt: null,
          failureReason: null,
          currentPhase: null,
        },
        'failed',
      );
    } catch (restoreErr) {
      this.deps.logger.error(
        `OrphanedRunsSweeper: Failed to restore run ${entry.uuid} to ${entry.previousStatus} after ${reason}:`,
        restoreErr,
      );
    }
  }

  // Restore the run from `running` (the post-enqueue status) back to its
  // pre-sweep status when enqueue failed after we had already committed the
  // `failed -> running` transition.
  private restoreRunToPreSweepAtomic(entry: SweepOrphanedRunEntry, reason: 'enqueueError'): void {
    const rolled = this.deps.runRepository.atomicUpdateByUuid(
      entry.uuid,
      {
        status: entry.previousStatus,
        completedAt: null,
        failureReason: null,
        currentPhase: null,
      },
      'running',
    );
    if (!rolled) {
      this.deps.logger.error(
        `OrphanedRunsSweeper: Critical - rollback atomicUpdateByUuid to ${entry.previousStatus} failed for run ${entry.uuid} (${reason})`,
      );
    }
  }
}
