import { createJob, reactivate, WorkerLeaseConflictError } from '@ai-sdlc/domain';
import type { WorkerId, JobId, RunId, IssueNumber, Run } from '@ai-sdlc/domain';
import type { SweepWaitingRuns, SweepWaitingRunsResult } from './sweep-waiting-runs.js';
import type { JobQueuePort, WorkerLeasePort } from './ports/index.js';
import type { RunRepositoryPort } from './ports.js';
import type { EventBusPort } from './ports/event-bus-port.js';
import type { LoggerPort } from './ports/logger-port.js';
import type { SweepOrphanedRuns } from './sweep-orphaned-runs.js';
import type { ResumeRunUseCase } from './use-cases.js';

const SWEEP_JOB_PRIORITY = 10;
const LEASE_TTL_MS = 30_000;

export interface WaitingRunsSweeperDeps {
  sweep: SweepWaitingRuns;
  orphanedSweep: SweepOrphanedRuns;
  resumeRun: ResumeRunUseCase;
  runRepository: RunRepositoryPort;
  leases: WorkerLeasePort;
  queue: JobQueuePort;
  eventBus: EventBusPort;
  now: () => Date;
  logger: LoggerPort;
}

export interface WaitingRunsSweeperResult extends SweepWaitingRunsResult {
  orphanedSwept: number;
  enqueued: number;
  skippedLeaseConflict: number;
  enqueueErrors: Array<{ runId: string; error: string }>;
}

export class WaitingRunsSweeper {
  constructor(private readonly deps: WaitingRunsSweeperDeps) {}

  async execute(workerId: WorkerId): Promise<WaitingRunsSweeperResult> {
    const orphanedResult = this.deps.orphanedSweep.execute();
    const sweepResult = await this.deps.sweep.execute();
    let enqueued = 0;
    let skippedLeaseConflict = 0;
    const enqueueErrors: Array<{ runId: string; error: string }> = [];

    const runsToResume = [
      ...orphanedResult.sweptRuns.map((run) => ({ run, reason: 'orphaned_resumption' })),
      ...sweepResult.reactivatedRuns.map((entry) => ({
        run: entry.run,
        reason: 'reactivated_by_sweep',
      })),
    ];

    for (const entry of runsToResume) {
      const run = entry.run;
      try {
        this.deps.eventBus.publish(run.uuid, {
          runId: run.uuid,
          phase: 'post-pr-review',
          level: 'info',
          type: 'post-pr-review.run.reactivated',
          message:
            entry.reason === 'orphaned_resumption'
              ? 'Orphaned run automatically resumed by sweep'
              : 'Run reactivated by sweep',
          timestamp: this.deps.now().toISOString(),
          metadata: { reason: entry.reason },
        });

        await this.deps.resumeRun.execute({
          runId: run.uuid as RunId,
          workerId,
        });
        enqueued++;
      } catch (err) {
        if (err instanceof WorkerLeaseConflictError) {
          skippedLeaseConflict++;
          this.deps.logger.error(
            `WaitingRunsSweeper: Lease conflict for run ${run.uuid}, skipping: ${err.message}`,
          );
        } else {
          const message = err instanceof Error ? err.message : String(err);
          enqueueErrors.push({ runId: run.uuid, error: message });
          this.deps.logger.error(
            `WaitingRunsSweeper: Failed to resume run ${run.uuid}: ${message}`,
          );
        }
      }
    }

    return {
      ...sweepResult,
      orphanedSwept: orphanedResult.swept,
      enqueued,
      skippedLeaseConflict,
      enqueueErrors,
    };
  }
}
