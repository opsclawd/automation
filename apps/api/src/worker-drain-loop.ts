import { workerLoop, type WorkerLoopDeps } from '@ai-sdlc/application';
import type { JobQueuePort, RunRepositoryPort, WorkerLeasePort } from '@ai-sdlc/application/ports';
import type { WorkerId, RunId } from '@ai-sdlc/domain';

const DEFAULT_DRAIN_INTERVAL_MS = 5_000;

function buildRecoverableRunIds(
  queue: JobQueuePort,
  runRepo: RunRepositoryPort,
  leases: WorkerLeasePort,
  now: Date,
): ReadonlySet<RunId> {
  const activeJobs = queue.listActive();
  const activeRuns = runRepo.findActiveRuns();
  const ids = new Set<RunId>();
  const runsWithActiveJobs = new Set<RunId>();
  for (const j of activeJobs) {
    runsWithActiveJobs.add(j.runId);
  }
  for (const r of activeRuns) {
    // Return set difference: active runs MINUS runs with active jobs.
    if (runsWithActiveJobs.has(r.uuid as RunId)) {
      continue;
    }
    // If the run has an active lease, we filter it out to prevent recovering runs that are in the middle of being reactivated by WaitingRunsSweeper.
    const lease = leases.current(r.repoId);
    const isLeased = lease !== undefined && lease.expiresAt.getTime() > now.getTime();
    if (!isLeased) {
      ids.add(r.uuid as RunId);
    }
  }
  return ids;
}

export function startWorkerDrainLoop(
  workerId: WorkerId,
  deps: Omit<WorkerLoopDeps, 'recoverableRunIds'> & { runRepository: RunRepositoryPort },
  intervalMs: number = DEFAULT_DRAIN_INTERVAL_MS,
  onError: (err: unknown) => void = (err) => console.error('worker-drain-loop tick failed:', err),
): { stop: () => void } {
  let isRunning = false;
  const tick = async (): Promise<void> => {
    if (isRunning) return;
    isRunning = true;
    try {
      const cutoff = deps.now();
      deps.queue.reclaimStaleClaims(cutoff);
      const recoverableRunIds = buildRecoverableRunIds(
        deps.queue,
        deps.runRepository,
        deps.leases,
        deps.now(),
      );
      await workerLoop(workerId, { ...deps, recoverableRunIds });
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
