import {
  workerLoop,
  type WorkerLoopDeps,
  RepositoryRecoveryCoordinator,
  type RepositoryRecoveryAction,
} from '@ai-sdlc/application';
import type { WorkerId, RunId } from '@ai-sdlc/domain';
import { generateJobOwnership, reactivate } from '@ai-sdlc/domain';

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
        ...(deps.getWorktreePath !== undefined ? { getWorktreePath: deps.getWorktreePath } : {}),
        ...(deps.getQuarantineRoot !== undefined
          ? { getQuarantineRoot: deps.getQuarantineRoot }
          : {}),
        ...(deps.listRunsForRepo !== undefined ? { listRunsForRepo: deps.listRunsForRepo } : {}),
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
        onWaitingReactivation: ({ repoId: _repoId, runId }) => {
          const run = deps.findRun(runId as RunId);
          if (!run) return;
          if (run.status !== 'waiting') return;
          const next = reactivate(run);
          try {
            deps.updateRun(runId as RunId, { status: next.status });
          } catch {
            /* ignore */
          }
        },
      });
      const enabledRepos = deps.repos.listEnabled();
      for (const repo of enabledRepos) {
        try {
          const action: RepositoryRecoveryAction = await coordinator.execute({ repoId: repo.id });
          if (action.action === 'requeue') {
            const jobs = deps.queue.listForRepo(repo.id);
            for (const job of jobs) {
              if (
                job.status === 'claimed' &&
                job.claimExpiresAt &&
                job.claimExpiresAt.getTime() < deps.now().getTime()
              ) {
                if (job.claimedBy && job.claimToken) {
                  try {
                    deps.queue.resetToQueued(generateJobOwnership(job, job.claimedBy));
                  } catch {
                    /* ignore */
                  }
                }
              }
            }
          }
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
