import type { Job, JobId, RepositoryId, RunId, WorkerId } from '@ai-sdlc/domain';

export interface EnqueueJobInput {
  job: Job;
}

export interface JobQueuePort {
  enqueue(input: EnqueueJobInput): void;
  claimNext(input: { workerId: WorkerId; skipJobIds?: Set<JobId> }): Job | undefined;
  releaseClaim(jobId: JobId): void;
  resetToQueued(jobId: JobId): void;
  markRunning(jobId: JobId, now: Date): void;
  markSucceeded(jobId: JobId, now: Date): void;
  markFailed(jobId: JobId, now: Date): void;
  markCancelled(jobId: JobId, now: Date): void;
  listForRepo(repoId: RepositoryId): Job[];
  listForRun(runId: RunId): Job[];
  findById(jobId: JobId): Job | undefined;
}
