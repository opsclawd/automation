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

const TERMINAL: ReadonlySet<JobStatus> = new Set(['succeeded', 'failed', 'cancelled']);

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

export function claimJob(job: Job, workerId: WorkerId, now: Date): Job {
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
  if (TERMINAL.has(job.status)) {
    throw new JobStateError(`cannot transition job ${job.id} to ${status}: already ${job.status}`);
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
