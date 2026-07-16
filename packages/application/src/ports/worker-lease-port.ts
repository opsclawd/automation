import type { RepositoryId, WorkerLease, LeaseToken } from '@ai-sdlc/domain';

export interface AcquireLeaseInput {
  repoId: RepositoryId;
  workerId: import('@ai-sdlc/domain').WorkerId;
  runId: import('@ai-sdlc/domain').RunId;
  now: Date;
  ttlMs: number;
}

export interface HeartbeatLeaseInput {
  repoId: RepositoryId;
  workerId: import('@ai-sdlc/domain').WorkerId;
  runId: import('@ai-sdlc/domain').RunId;
  now: Date;
  newExpiresAt: Date;
  leaseToken: LeaseToken;
}

export interface ReleaseLeaseInput {
  repoId: RepositoryId;
  workerId: import('@ai-sdlc/domain').WorkerId;
  runId: import('@ai-sdlc/domain').RunId;
  leaseToken: LeaseToken;
}

export interface WorkerLeasePort {
  acquire(input: AcquireLeaseInput): WorkerLease;
  heartbeat(input: HeartbeatLeaseInput): void;
  release(input: ReleaseLeaseInput): void;
  current(repoId: RepositoryId): WorkerLease | undefined;
  checkActiveLease(repoId: RepositoryId, now: Date): boolean;
}
