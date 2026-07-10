import { workerLoop, type WorkerLoopDeps } from '@ai-sdlc/application';
import type { RunRepositoryPort, WorkerLeasePort, JobQueuePort } from '@ai-sdlc/application/ports';
import type { WorkerId, RunId } from '@ai-sdlc/domain';

const DEFAULT_DRAIN_INTERVAL_MS = 5_000;

function buildRecoverableRunIds(
  runRepo: RunRepositoryPort,
  leases: WorkerLeasePort,
  queue: JobQueuePort,
  now: Date,
): ReadonlySet<RunId> {
  const activeRuns = runRepo.findActiveRuns();
  const ids = new Set<RunId>();
  const activeRunIdsFromJobs = new Set(
    queue.listActive()
      .filter((j) => j.status === 'queued')
      .map((j) => j.runId)
  );
  for (const r of activeRuns) {
    if (activeRunIdsFromJobs.has(r.uuid as RunId)) continue;
    // If the run has an active lease, we filter it out to prevent recovering runs that are in the middle of being reactivated by WaitingRunsSweeper.
    if (!leases.checkActiveLease(r.repoId, now)) {
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
        deps.runRepository,
        deps.leases,
        deps.queue,
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
