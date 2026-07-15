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
  /** Returns jobs whose status is 'claimed' AND claim_expires_at < cutoff. */
  findExpiredClaims(cutoff: Date): Job[];
  /** Sets status='queued', claimed_by=NULL, claimed_at=NULL, claim_expires_at=NULL
      on every job whose status='claimed' AND claim_expires_at < cutoff.
      Returns the number of rows reclaimed. */
  reclaimStaleClaims(cutoff: Date): number;
  listActive(): Job[];
}
