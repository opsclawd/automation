import type { RepositoryId, RunId, WorkerId } from './ids.js';
export interface WorkerLease {
  repoId: RepositoryId;
  workerId: WorkerId;
  runId: RunId;
  acquiredAt: Date;
  heartbeatAt: Date;
  expiresAt: Date;
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
