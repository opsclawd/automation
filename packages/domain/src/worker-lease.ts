import type { RepositoryId, RunId, WorkerId } from './ids.js';

export type LeaseToken = string & { readonly __brand: 'LeaseToken' };

export interface WorkerLease {
  repoId: RepositoryId;
  workerId: WorkerId;
  runId: RunId;
  acquiredAt: Date;
  heartbeatAt: Date;
  expiresAt: Date;
  leaseToken: LeaseToken;
}

export class WorkerLeaseConflictError extends Error {
  readonly repoId: RepositoryId;
  readonly currentWorker: WorkerId;
  constructor(repoId: RepositoryId, currentWorker: WorkerId) {
    super(`Repository ${repoId} already has an active lease held by ${currentWorker}`);
    this.name = 'WorkerLeaseConflictError';
    this.repoId = repoId;
    this.currentWorker = currentWorker;
  }
}

export class LeaseOwnershipLostError extends Error {
  readonly repoId: RepositoryId;
  readonly leaseToken: LeaseToken;
  constructor(repoId: RepositoryId, leaseToken: LeaseToken) {
    super(`WorkerLease ownership lost for ${repoId}`);
    this.name = 'LeaseOwnershipLostError';
    this.repoId = repoId;
    this.leaseToken = leaseToken;
  }
}
