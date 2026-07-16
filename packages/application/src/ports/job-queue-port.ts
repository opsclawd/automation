import type { Job, JobId, RepositoryId, RunId, WorkerId, JobOwnership } from '@ai-sdlc/domain';

export interface EnqueueJobInput {
  job: Job;
}

export interface ClaimNextInput {
  workerId: WorkerId;
  repoId: RepositoryId;
  skipJobIds?: Set<JobId>;
  ttlMs?: number;
}

export interface JobQueuePort {
  enqueue(input: EnqueueJobInput): void;
  claimNext(input: ClaimNextInput): Job | undefined;
  releaseClaim(owner: JobOwnership): void;
  resetToQueued(owner: JobOwnership): void;
  markRunning(owner: JobOwnership, now: Date): void;
  markSucceeded(owner: JobOwnership, now: Date): void;
  markFailed(owner: JobOwnership, now: Date): void;
  markCancelled(owner: JobOwnership, now: Date): void;
  listForRepo(repoId: RepositoryId): Job[];
  listForRun(runId: RunId): Job[];
  findById(jobId: JobId): Job | undefined;
  listActive(): Job[];
}
