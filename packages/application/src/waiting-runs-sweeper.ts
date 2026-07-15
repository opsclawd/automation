import {
  createJob,
  reactivate,
  WorkerLeaseConflictError,
  LeaseOwnershipLostError,
} from '@ai-sdlc/domain';
import type { WorkerId, JobId, RunId, IssueNumber, Run } from '@ai-sdlc/domain';
import type { SweepWaitingRuns, SweepWaitingRunsResult } from './sweep-waiting-runs.js';
import type { JobQueuePort, WorkerLeasePort } from './ports/index.js';
import type { RunRepositoryPort } from './ports.js';
import type { EventBusPort } from './ports/event-bus-port.js';
import type { LoggerPort } from './ports/logger-port.js';

const SWEEP_JOB_PRIORITY = 10;
const LEASE_TTL_MS = 30_000;

export interface WaitingRunsSweeperDeps {
  sweep: SweepWaitingRuns;
  runRepository: RunRepositoryPort;
  leases: WorkerLeasePort;
  queue: JobQueuePort;
  eventBus: EventBusPort;
  now: () => Date;
  logger: LoggerPort;
}

export interface WaitingRunsSweeperResult extends SweepWaitingRunsResult {
  enqueued: number;
  skippedLeaseConflict: number;
  enqueueErrors: Array<{ runId: string; error: string }>;
}

export class WaitingRunsSweeper {
  constructor(private readonly deps: WaitingRunsSweeperDeps) {}

  async execute(workerId: WorkerId): Promise<WaitingRunsSweeperResult> {
    const sweepResult = await this.deps.sweep.execute();
    let enqueued = 0;
    let skippedLeaseConflict = 0;
    const enqueueErrors: Array<{ runId: string; error: string }> = [];

    for (const entry of sweepResult.reactivatedRuns) {
      const run = entry.run;
      let leaseAcquired = false;
      let acquiredLease;
      try {
        acquiredLease = this.deps.leases.acquire({
          repoId: run.repoId,
          workerId,
          runId: run.uuid as RunId,
          now: this.deps.now(),
          ttlMs: LEASE_TTL_MS,
        });
        leaseAcquired = true;
      } catch (err) {
        if (err instanceof WorkerLeaseConflictError) {
          skippedLeaseConflict++;
          this.deps.logger.error(
            `WaitingRunsSweeper: Lease conflict for run ${run.uuid}, skipping: ${err.message}`,
          );
        } else {
          enqueueErrors.push({
            runId: run.uuid,
            error: err instanceof Error ? err.message : String(err),
          });
          this.deps.logger.error(
            `WaitingRunsSweeper: Failed to acquire lease for run ${run.uuid}:`,
            err,
          );
        }
        continue;
      }

      const originalStatus = run.status;
      const originalRun = { ...run };
      try {
        const next = reactivate(run as Run);
        const updated = this.deps.runRepository.atomicUpdateByUuid(run.uuid, next, originalStatus);
        if (!updated) {
          this.deps.logger.error(
            `WaitingRunsSweeper: run ${run.uuid} status changed concurrently (expected ${originalStatus}), skipping`,
          );
          continue;
        }

        try {
          this.deps.eventBus.publish(run.uuid, {
            runId: run.uuid,
            phase: 'post-pr-review',
            level: 'info',
            type: 'post-pr-review.run.reactivated',
            message: 'Run reactivated by sweep',
            timestamp: this.deps.now().toISOString(),
            metadata: { reason: 'reactivated_by_sweep' },
          });

          const job = createJob({
            id: `sweep-${run.uuid}-${this.deps.now().getTime()}` as JobId,
            runId: run.uuid as RunId,
            repoId: run.repoId,
            issueNumber: run.issueNumber as IssueNumber,
            priority: SWEEP_JOB_PRIORITY,
            createdAt: this.deps.now(),
          });
          this.deps.queue.enqueue({ job });
          enqueued++;
        } catch (err) {
          // Log original error that caused the rollback before event publishing or rollback status update
          this.deps.logger.error(
            `WaitingRunsSweeper: Rollback for run ${run.uuid} due to error:`,
            err,
          );
          // Rollback status to prevent split-brain run. Restore the original run object fully.
          const rollbackSuccess = this.deps.runRepository.atomicUpdateByUuid(
            run.uuid,
            originalRun as Run,
            'running',
          );
          if (!rollbackSuccess) {
            this.deps.logger.error(
              `WaitingRunsSweeper: Critical failure - Rollback atomicUpdateByUuid failed for run ${run.uuid}. Run is stuck in 'running' status.`,
            );
          }
          try {
            this.deps.eventBus.publish(run.uuid, {
              runId: run.uuid,
              phase: 'post-pr-review',
              level: 'error',
              type: 'post-pr-review.sweep.rollback',
              message: 'Rollback status to waiting due to enqueue or publish failure',
              timestamp: this.deps.now().toISOString(),
              metadata: { error: err instanceof Error ? err.message : String(err) },
            });
          } catch (pubErr) {
            this.deps.logger.error(`Failed to publish rollback event for ${run.uuid}:`, pubErr);
          }
          throw err;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        enqueueErrors.push({ runId: run.uuid, error: message });
        this.deps.logger.error(
          `WaitingRunsSweeper: enqueue failed for run ${run.uuid}: ${message}`,
        );
      } finally {
        if (leaseAcquired && acquiredLease) {
          try {
            this.deps.leases.release({
              repoId: run.repoId,
              workerId,
              runId: run.uuid as RunId,
              leaseToken: acquiredLease.leaseToken,
            });
          } catch (relErr) {
            if (!(relErr instanceof LeaseOwnershipLostError)) {
              this.deps.logger.error(
                `WaitingRunsSweeper: Failed to release lease on failure for ${run.uuid}:`,
                relErr,
              );
            }
          }
        }
      }
    }

    return { ...sweepResult, enqueued, skippedLeaseConflict, enqueueErrors };
  }
}
