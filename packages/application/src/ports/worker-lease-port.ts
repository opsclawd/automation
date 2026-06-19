import type { RepositoryId, RunId, WorkerId, WorkerLease } from '@ai-sdlc/domain';

export interface AcquireLeaseInput {
  repoId: RepositoryId;
  workerId: WorkerId;
  runId: RunId;
  now: Date;
  ttlMs: number;
}

export interface ReclaimExpiredInput {
  now: Date;
  recoverableRunIds: ReadonlySet<RunId>;
  isWorkerAlive(workerId: WorkerId): boolean;
  resetWorktree(repoId: RepositoryId): void;
  reclaimedByWorkerId: WorkerId;
  onReclaimed(info: {
    repoId: RepositoryId;
    previousWorkerId: WorkerId;
    previousRunId: RunId;
    reclaimedByWorkerId: WorkerId;
    reason: string;
  }): void;
}

export interface WorkerLeasePort {
  acquire(input: AcquireLeaseInput): WorkerLease;
  heartbeat(repoId: RepositoryId, workerId: WorkerId, now: Date, newExpiresAt: Date): void;
  release(repoId: RepositoryId, workerId: WorkerId): void;
  current(repoId: RepositoryId): WorkerLease | undefined;
  reclaimExpired(input: ReclaimExpiredInput): WorkerLease[];
}
