import type { JobId, RepositoryId, RunId, WorkerId, IssueNumber } from './ids.js';

export type JobStatus = 'queued' | 'claimed' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Job {
  id: JobId;
  runId: RunId;
  repoId: RepositoryId;
  issueNumber: IssueNumber;
  status: JobStatus;
  priority: number;
  attempts: number;
  claimedBy?: WorkerId;
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

export class DuplicateJobIdError extends Error {
  readonly jobId: JobId;
  constructor(jobId: JobId) {
    super(`duplicate job id ${jobId}`);
    this.name = 'DuplicateJobIdError';
    this.jobId = jobId;
  }
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
    claimedAt: now,
    attempts: job.attempts + 1,
    ...(ttlMs !== undefined ? { claimExpiresAt: new Date(now.getTime() + ttlMs) } : {}),
  };
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

export function unclaimJob(job: Job): Job {
  if (job.status !== 'claimed') {
    throw new JobStateError(
      `cannot release claim on job ${job.id}: status is '${job.status}', expected 'claimed'`,
    );
  }
  const { claimedBy, claimedAt, ...rest } = job;
  void claimedBy;
  void claimedAt;
  return { ...rest, status: 'queued' };
}

export function resetJobToQueued(job: Job): Job {
  if (job.status !== 'claimed' && job.status !== 'running') {
    throw new JobStateError(
      `cannot reset job ${job.id} to queued: status is '${job.status}', expected 'claimed' or 'running'`,
    );
  }
  const { claimedBy, claimedAt, startedAt, ...rest } = job;
  void claimedBy;
  void claimedAt;
  void startedAt;
  return { ...rest, status: 'queued' };
}
