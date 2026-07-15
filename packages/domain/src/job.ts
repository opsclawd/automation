import type { JobId, RepositoryId, RunId, WorkerId, IssueNumber } from './ids.js';

export type JobStatus = 'queued' | 'claimed' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type ClaimToken = string & { readonly __brand: 'ClaimToken' };

export interface JobOwnership {
  jobId: JobId;
  workerId: WorkerId;
  claimToken: ClaimToken;
}

export interface Job {
  id: JobId;
  runId: RunId;
  repoId: RepositoryId;
  issueNumber: IssueNumber;
  status: JobStatus;
  priority: number;
  attempts: number;
  claimedBy?: WorkerId;
  claimToken?: ClaimToken;
  createdAt: Date;
  claimedAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  claimExpiresAt?: Date;
}

export interface CreateJobInput {
  id: JobId;
  runId: RunId;
  repoId: RepositoryId;
  issueNumber: IssueNumber;
  priority?: number;
  createdAt: Date;
}

export class JobStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobStateError';
  }
}

export class JobOwnershipLostError extends Error {
  readonly jobId: JobId;
  constructor(jobId: JobId) {
    super(`job ownership lost: ${jobId}`);
    this.name = 'JobOwnershipLostError';
    this.jobId = jobId;
  }
}

export class DuplicateJobIdError extends Error {
  readonly jobId: JobId;
  constructor(jobId: JobId) {
    super(`duplicate job id ${jobId}`);
    this.name = 'DuplicateJobIdError';
    this.jobId = jobId;
  }
}

export function newClaimToken(): ClaimToken {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('') as ClaimToken;
}

export function generateJobOwnership(job: Job, workerId: WorkerId): JobOwnership {
  if (!job.claimToken) {
    throw new Error(`job ${job.id} has no claimToken`);
  }
  return { jobId: job.id, workerId, claimToken: job.claimToken };
}

export function createJob(input: CreateJobInput): Job {
  return {
    id: input.id,
    runId: input.runId,
    repoId: input.repoId,
    issueNumber: input.issueNumber,
    status: 'queued',
    priority: input.priority ?? 0,
    attempts: 0,
    createdAt: input.createdAt,
  };
}

export function claimJob(job: Job, workerId: WorkerId, now: Date, ttlMs?: number): Job {
  if (job.status !== 'queued') {
    throw new JobStateError(
      `cannot claim job ${job.id}: status is '${job.status}', expected 'queued'`,
    );
  }
  return {
    ...job,
    status: 'claimed',
    claimedBy: workerId,
    claimToken: newClaimToken(),
    claimedAt: now,
    attempts: job.attempts + 1,
    ...(ttlMs !== undefined ? { claimExpiresAt: new Date(now.getTime() + ttlMs) } : {}),
  };
}

export function claimJobWithOwnership(
  job: Job,
  workerId: WorkerId,
  now: Date,
  ttlMs?: number,
): { job: Job; ownership: JobOwnership } {
  const claimed = claimJob(job, workerId, now, ttlMs);
  const ownership = generateJobOwnership(claimed, workerId);
  return { job: claimed, ownership };
}

export function markJobRunning(job: Job, now: Date): Job {
  if (job.status !== 'claimed') {
    throw new JobStateError(
      `cannot mark job ${job.id} running: status is '${job.status}', expected 'claimed'`,
    );
  }
  return { ...job, status: 'running', startedAt: now };
}

function terminate(job: Job, status: 'succeeded' | 'failed' | 'cancelled', now: Date): Job {
  if (job.status !== 'running') {
    throw new JobStateError(
      `cannot mark job ${job.id} ${status}: status is '${job.status}', expected 'running'`,
    );
  }
  return { ...job, status, completedAt: now };
}

export function markJobSucceeded(job: Job, now: Date): Job {
  return terminate(job, 'succeeded', now);
}

export function markJobFailed(job: Job, now: Date): Job {
  return terminate(job, 'failed', now);
}

export function markJobCancelled(job: Job, now: Date): Job {
  return terminate(job, 'cancelled', now);
}

export function markJobRunningWithOwnership(job: Job, owner: JobOwnership, now: Date): Job {
  if (job.claimToken !== owner.claimToken) {
    throw new JobStateError(`cannot mark job ${job.id} running: claim token mismatch`);
  }
  return markJobRunning(job, now);
}

export function markJobSucceededWithOwnership(job: Job, owner: JobOwnership, now: Date): Job {
  if (job.claimToken !== owner.claimToken) {
    throw new JobStateError(`cannot mark job ${job.id} succeeded: claim token mismatch`);
  }
  return markJobSucceeded(job, now);
}

export function markJobFailedWithOwnership(job: Job, owner: JobOwnership, now: Date): Job {
  if (job.claimToken !== owner.claimToken) {
    throw new JobStateError(`cannot mark job ${job.id} failed: claim token mismatch`);
  }
  return markJobFailed(job, now);
}

export function markJobCancelledWithOwnership(job: Job, owner: JobOwnership, now: Date): Job {
  if (job.claimToken !== owner.claimToken) {
    throw new JobStateError(`cannot mark job ${job.id} cancelled: claim token mismatch`);
  }
  return markJobCancelled(job, now);
}

export function unclaimJob(job: Job): Job {
  if (job.status !== 'claimed') {
    throw new JobStateError(
      `cannot release claim on job ${job.id}: status is '${job.status}', expected 'claimed'`,
    );
  }
  const { claimedBy, claimedAt, claimToken, ...rest } = job;
  void claimedBy;
  void claimedAt;
  void claimToken;
  return { ...rest, status: 'queued' };
}

export function releaseClaimWithOwnership(job: Job, owner: JobOwnership): Job {
  if (job.claimToken !== owner.claimToken) {
    throw new JobStateError(`cannot release claim on job ${job.id}: claim token mismatch`);
  }
  return unclaimJob(job);
}

export function resetJobToQueued(job: Job): Job {
  if (job.status !== 'claimed' && job.status !== 'running') {
    throw new JobStateError(
      `cannot reset job ${job.id} to queued: status is '${job.status}', expected 'claimed' or 'running'`,
    );
  }
  const { claimedBy, claimedAt, startedAt, claimToken, ...rest } = job;
  void claimedBy;
  void claimedAt;
  void startedAt;
  void claimToken;
  return { ...rest, status: 'queued' };
}

export function resetJobToQueuedWithOwnership(job: Job, owner: JobOwnership): Job {
  if (job.claimToken !== owner.claimToken) {
    throw new JobStateError(`cannot reset job ${job.id} to queued: claim token mismatch`);
  }
  return resetJobToQueued(job);
}
