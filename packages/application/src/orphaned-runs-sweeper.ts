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

    for (const entry of entries) {
      const run = entry.run;

      // Lease guard: a live worker holds the lease for this repo. Skip —
      // the drain loop will pick up the run when the worker eventually
      // finishes or the lease expires.
      if (this.deps.leases.checkActiveLease(run.repoId, this.deps.now())) {
        result.skippedLeaseConflict++;
        this.deps.logger.error(
          `OrphanedRunsSweeper: Active lease for repo ${run.repoId}, skipping ${run.uuid}`,
        );
        continue;
      }

      // Idempotency: another sweeper tick (or the same tick in another
      // process) already enqueued a job for this run.
      const activeForRun = this.deps.queue.listForRun(run.uuid as RunId);
      if (activeForRun.length > 0) {
        result.skippedAlreadyQueued++;
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
        } else {
          result.enqueueErrors.push({
            runId: run.uuid,
            error: err instanceof Error ? err.message : String(err),
          });
          this.deps.logger.error(
            `OrphanedRunsSweeper: Failed to acquire lease for run ${run.uuid}:`,
            err,
          );
        }
        continue;
      }

      const expectedStatus = run.status; // 'failed' from SweepOrphanedRuns
      const originalRun = { ...run };
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
          this.deps.queue.enqueue({ job });

          this.deps.eventBus.publish(run.uuid, {
            runId: run.uuid,
            level: 'info',
            type: 'orchestrator.run.recovered_from_orphan',
            message: `Run recovered from orphaned pid ${entry.previousPid}`,
            timestamp: this.deps.now().toISOString(),
            metadata: { previousPid: entry.previousPid },
          });

          result.enqueued++;
        } catch (err) {
          this.deps.logger.error(
            `OrphanedRunsSweeper: Enqueue failed for run ${run.uuid}, rolling back to failed:`,
            err,
          );
          const rolled = this.deps.runRepository.atomicUpdateByUuid(
            run.uuid,
            {
              status: originalRun.status,
              completedAt: originalRun.completedAt ?? null,
              failureReason: originalRun.failureReason ?? null,
            },
            'running',
          );
          if (!rolled) {
            this.deps.logger.error(
              `OrphanedRunsSweeper: Critical - rollback atomicUpdateByUuid failed for run ${run.uuid}`,
            );
          }
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
            this.deps.leases.release(run.repoId, 'orphan-sweeper' as unknown as WorkerId);
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
}
