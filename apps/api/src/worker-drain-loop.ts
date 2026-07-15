import {
  workerLoop,
  type WorkerLoopDeps,
  RepositoryRecoveryCoordinator,
} from '@ai-sdlc/application';
import type { WorkerId } from '@ai-sdlc/domain';
import type { JobQueuePort } from '@ai-sdlc/application/ports';
import { generateJobOwnership } from '@ai-sdlc/domain';

const DEFAULT_DRAIN_INTERVAL_MS = 5_000;

export function startWorkerDrainLoop(
  workerId: WorkerId,
  deps: Omit<WorkerLoopDeps, 'recoverableRunIds'>,
  intervalMs: number = DEFAULT_DRAIN_INTERVAL_MS,
  onError: (err: unknown) => void = (err) => console.error('worker-drain-loop tick failed:', err),
): { stop: () => void } {
  let isRunning = false;
  const tick = async (): Promise<void> => {
    if (isRunning) return;
    isRunning = true;
    try {
      const coordinator = new RepositoryRecoveryCoordinator({
        leases: deps.leases,
        queue: deps.queue,
        registry: deps.registry,
        repos: deps.repos,
        findRun: deps.findRun,
        isWorkerAlive: deps.isWorkerAlive,
        resetWorktree: deps.resetWorktree,
        now: deps.now,
        onOrphan: ({ runId }) => {
          const jobs = deps.queue.listForRun(runId);
          for (const job of jobs) {
            if (job.status === 'claimed' || job.status === 'running') {
              if (job.claimedBy && job.claimToken) {
                try {
                  (
                    deps.queue as JobQueuePort & {
                      resetToQueued?: (ownership: {
                        jobId: unknown;
                        workerId: unknown;
                        claimToken: unknown;
                      }) => void;
                    }
                  ).resetToQueued?.(generateJobOwnership(job, job.claimedBy));
                } catch {
                  /* ignore */
                }
              }
            }
          }
        },
        onWaitingReactivation: () => {},
      });
      const enabledRepos = deps.repos.listEnabled();
      for (const repo of enabledRepos) {
        await coordinator.execute({ repoId: repo.id });
      }
      await workerLoop(workerId, deps);
    } catch (err) {
      onError(err);
    } finally {
      isRunning = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  return { stop: () => clearInterval(timer) };
}
