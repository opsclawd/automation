import type { WorkerId, RepositoryId, RunId, Run } from '@ai-sdlc/domain';
import type {
  WorkerRegistryPort,
  JobQueuePort,
  WorkerLeasePort,
  RepositoryPort,
} from '../ports.js';
import { WorkerLeaseConflictError } from '@ai-sdlc/domain';

export interface WorkerLoopDeps {
  registry: WorkerRegistryPort;
  queue: JobQueuePort;
  leases: WorkerLeasePort;
  repos: RepositoryPort;
  executeRun: (input: { run: Run; workerId: WorkerId; cwd: string }) => Promise<{ ok: boolean }>;
  prepareWorktree: (input: { repoId: RepositoryId; runId: RunId }) => Promise<{ cwd: string }>;
  resetWorktree: (repoId: RepositoryId) => void;
  isWorkerAlive: (workerId: WorkerId) => boolean;
  recoverableRunIds: ReadonlySet<RunId>;
  now: () => Date;
  ttlMs: number;
  findRun: (runId: RunId) => Run | undefined;
}

export async function workerLoop(workerId: WorkerId, deps: WorkerLoopDeps): Promise<void> {
  const { registry, queue, leases } = deps;

  registry.markIdle(workerId);

  leases.reclaimExpired({
    now: deps.now(),
    recoverableRunIds: deps.recoverableRunIds,
    isWorkerAlive: deps.isWorkerAlive,
    resetWorktree: deps.resetWorktree,
    onReclaimed: (_info) => {},
  });

  const job = queue.claimNext({ workerId });
  if (!job) {
    return;
  }

  registry.markBusy(workerId);

  try {
    leases.acquire({
      repoId: job.repoId,
      workerId,
      runId: job.runId,
      now: deps.now(),
      ttlMs: deps.ttlMs,
    });

    queue.markRunning(job.id, deps.now());

    const worktree = await deps.prepareWorktree({
      repoId: job.repoId,
      runId: job.runId,
    });

    const run = deps.findRun(job.runId);
    if (!run) {
      throw new Error(`run ${job.runId} not found for job ${job.id}`);
    }

    const result = await deps.executeRun({ run, workerId, cwd: worktree.cwd });

    if (result.ok) {
      queue.markSucceeded(job.id, deps.now());
    } else {
      queue.markFailed(job.id, deps.now());
    }
  } catch (err) {
    if (err instanceof WorkerLeaseConflictError) {
      return;
    }
    queue.markFailed(job.id, deps.now());
  } finally {
    leases.release(job.repoId, workerId);
    registry.markIdle(workerId);
  }
}
