import type { WorkerId, RepositoryId, RunId, Run } from '@ai-sdlc/domain';
import type {
  WorkerRegistryPort,
  JobQueuePort,
  WorkerLeasePort,
  RepositoryPort,
} from '../ports.js';

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

export async function workerLoop(_workerId: WorkerId, _deps: WorkerLoopDeps): Promise<void> {
  // stub — implementation in Task 3
}
