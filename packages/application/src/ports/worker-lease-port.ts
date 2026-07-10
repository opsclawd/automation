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
  /**
   * Called for each reclaimed lease BEFORE the lease is deleted.
   * Implementations MUST invoke this before removing the lease entry so the
   * callback can safely requeue claimed/running jobs. If the callback throws,
   * the lease MUST be preserved (not deleted) to prevent a job from being left
   * in a non-claimable state without an active lease protecting the repo.
   * This callback MUST be idempotent — it may be invoked multiple times for the
   * same lease in the event of a transient failure on a previous reclaim attempt
   * (e.g. the DELETE step threw after this callback succeeded).
   */
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
  checkActiveLease(repoId: RepositoryId, now: Date): boolean;
  reclaimExpired(input: ReclaimExpiredInput): WorkerLease[];
}
