import {
  type Job,
  type JobId,
  type RepositoryId,
  type RunId,
  type WorkerId,
  claimJob,
  markJobRunning,
  markJobSucceeded,
  markJobFailed,
  markJobCancelled,
  RepositoryNotApprovedError,
  DuplicateJobIdError,
} from '@ai-sdlc/domain';
import type { JobQueuePort, EnqueueJobInput } from '../ports/job-queue-port.js';
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

  claimNext(input: { workerId: WorkerId }): Job | undefined {
    const queued = [...this.jobs.values()]
      .filter((j) => j.status === 'queued')
      // Sort: descending priority, then ascending createdAt, then ascending id
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      );
    const next = queued[0];
    if (!next) return undefined;
    const claimed = claimJob(next, input.workerId, new Date());
    this.jobs.set(claimed.id, claimed);
    return claimed;
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

  private update(jobId: JobId, fn: (j: Job) => Job): void {
    const existing = this.jobs.get(jobId);
    if (!existing) throw new Error(`unknown job ${jobId}`);
    this.jobs.set(jobId, fn(existing));
  }
}
