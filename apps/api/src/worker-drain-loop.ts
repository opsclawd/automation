import {
  workerLoop,
  type WorkerLoopDeps,
  RepositoryRecoveryCoordinator,
} from '@ai-sdlc/application';
import type { WorkerId } from '@ai-sdlc/domain';
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
        ...(deps.checkPid !== undefined ? { checkPid: deps.checkPid } : {}),
        ...(deps.registryWorkerHostname !== undefined
          ? { registryWorkerHostname: deps.registryWorkerHostname }
          : {}),
        ...(deps.worktreeRecovery !== undefined ? { worktreeRecovery: deps.worktreeRecovery } : {}),
        ...(deps.operationalRecovery !== undefined
          ? { operationalRecovery: deps.operationalRecovery }
          : {}),
        onOrphan: ({ runId }) => {
          const jobs = deps.queue.listForRun(runId);
          for (const job of jobs) {
            if (job.status === 'claimed' || job.status === 'running') {
              if (job.claimedBy && job.claimToken) {
                try {
                  deps.queue.resetToQueued(generateJobOwnership(job, job.claimedBy));
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
        try {
          await coordinator.execute({ repoId: repo.id });
        } catch {
          /* ignore - one repo recovery failure should not block others */
        }
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
