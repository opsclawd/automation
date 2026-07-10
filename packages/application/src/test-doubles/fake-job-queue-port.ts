import {
  type Job,
  type JobId,
  type RepositoryId,
  type RunId,
  claimJob,
  unclaimJob,
  resetJobToQueued,
  markJobRunning,
  markJobSucceeded,
  markJobFailed,
  markJobCancelled,
  RepositoryNotApprovedError,
  DuplicateJobIdError,
} from '@ai-sdlc/domain';
import type { JobQueuePort, EnqueueJobInput, ClaimNextInput } from '../ports/job-queue-port.js';
import type { RepositoryPort } from '../ports.js';

export class FakeJobQueuePort implements JobQueuePort {
  private jobs = new Map<JobId, Job>();
  constructor(private readonly repos: RepositoryPort) {}

  enqueue(input: EnqueueJobInput): void {
    const repo = this.repos.findById(input.job.repoId);
    if (!repo || !repo.enabled) {
      throw new RepositoryNotApprovedError(input.job.repoId);
    }
    if (this.jobs.has(input.job.id)) {
      throw new DuplicateJobIdError(input.job.id);
    }
    this.jobs.set(input.job.id, input.job);
  }

  claimNext(input: ClaimNextInput): Job | undefined {
    const queued = [...this.jobs.values()]
      .filter((j) => j.status === 'queued' && !input.skipJobIds?.has(j.id))
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      );
    const next = queued[0];
    if (!next) return undefined;
    const claimed = claimJob(next, input.workerId, new Date(), input.ttlMs);
    this.jobs.set(claimed.id, claimed);
    return claimed;
  }

  releaseClaim(jobId: JobId): void {
    this.update(jobId, (j) => unclaimJob(j));
  }

  resetToQueued(jobId: JobId): void {
    this.update(jobId, (j) => resetJobToQueued(j));
  }

  markRunning(jobId: JobId, now: Date): void {
    this.update(jobId, (j) => markJobRunning(j, now));
  }
  markSucceeded(jobId: JobId, now: Date): void {
    this.update(jobId, (j) => markJobSucceeded(j, now));
  }
  markFailed(jobId: JobId, now: Date): void {
    this.update(jobId, (j) => markJobFailed(j, now));
  }
  markCancelled(jobId: JobId, now: Date): void {
    this.update(jobId, (j) => markJobCancelled(j, now));
  }

  listForRepo(repoId: RepositoryId): Job[] {
    return [...this.jobs.values()].filter((j) => j.repoId === repoId);
  }
  listForRun(runId: RunId): Job[] {
    return [...this.jobs.values()].filter((j) => j.runId === runId);
  }
  findById(jobId: JobId): Job | undefined {
    return this.jobs.get(jobId);
  }

  findExpiredClaims(cutoff: Date): Job[] {
    return [...this.jobs.values()].filter(
      (j) =>
        j.status === 'claimed' &&
        j.claimExpiresAt !== undefined &&
        j.claimExpiresAt.getTime() < cutoff.getTime(),
    );
  }

  reclaimStaleClaims(cutoff: Date): number {
    const expired = this.findExpiredClaims(cutoff);
    for (const j of expired) {
      const { claimedBy, claimedAt, claimExpiresAt: _ce, ...rest } = j;
      void claimedBy;
      void claimedAt;
      void _ce;
      this.jobs.set(j.id, { ...rest, status: 'queued' });
    }
    return expired.length;
  }

  listActive(): Job[] {
    return [...this.jobs.values()].filter((j) => j.status === 'claimed' || j.status === 'running');
  }

  private update(jobId: JobId, fn: (j: Job) => Job): void {
    const existing = this.jobs.get(jobId);
    if (!existing) throw new Error(`unknown job ${jobId}`);
    this.jobs.set(jobId, fn(existing));
  }
}
