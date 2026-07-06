import {
  claimJob,
  markJobCancelled,
  markJobFailed,
  markJobRunning,
  markJobSucceeded,
  resetJobToQueued,
  unclaimJob,
  type Job,
  type JobId,
  type RepositoryId,
  type RunId,
  type WorkerId,
  type IssueNumber,
  RepositoryNotApprovedError,
  DuplicateJobIdError,
  type JobStatus,
  JobId as mkJobId,
  RepositoryId as mkRepositoryId,
  RunId as mkRunId,
  WorkerId as mkWorkerId,
} from '@ai-sdlc/domain';
import type {
  JobQueuePort,
  RepositoryPort,
  EnqueueJobInput,
  ClaimNextInput,
} from '@ai-sdlc/application/ports';
import type { Db } from './database.js';

interface JobRow {
  id: string;
  run_id: string;
  repo_id: string;
  issue_number: number;
  status: string;
  priority: number;
  attempts: number;
  claimed_by: string | null;
  created_at: string;
  claimed_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  claim_expires_at: string | null;
}

function toJob(row: JobRow): Job {
  const job: Job = {
    id: mkJobId(row.id),
    runId: mkRunId(row.run_id),
    repoId: mkRepositoryId(row.repo_id),
    issueNumber: row.issue_number as IssueNumber,
    status: row.status as JobStatus,
    priority: row.priority,
    attempts: row.attempts,
    createdAt: new Date(row.created_at),
  };
  if (row.claimed_by !== null) {
    job.claimedBy = mkWorkerId(row.claimed_by);
  }
  if (row.claimed_at !== null) {
    job.claimedAt = new Date(row.claimed_at);
  }
  if (row.started_at !== null) {
    job.startedAt = new Date(row.started_at);
  }
  if (row.completed_at !== null) {
    job.completedAt = new Date(row.completed_at);
  }
  if (row.claim_expires_at !== null) {
    job.claimExpiresAt = new Date(row.claim_expires_at);
  }
  return job;
}

export class JobQueueRepository implements JobQueuePort {
  private readonly claimTx: (
    workerId: WorkerId,
    skipJobIds: Set<JobId> | undefined,
    ttlMs: number | undefined,
    repoId?: RepositoryId,
  ) => Job | undefined;

  constructor(
    private readonly db: Db,
    private readonly repos: RepositoryPort,
  ) {
    this.claimTx = this.db.transaction(
      (
        workerId: WorkerId,
        skipJobIds: Set<JobId> | undefined,
        ttlMs: number | undefined,
        repoId?: RepositoryId,
      ): Job | undefined => {
        let query = `SELECT * FROM jobs WHERE status = 'queued'`;
        const params: unknown[] = [];
        if (repoId) {
          query += ` AND repo_id = ?`;
          params.push(repoId);
        }
        query += ` ORDER BY priority DESC, created_at ASC, id ASC`;

        const rows = this.db.prepare(query).all(...(params as (string | number)[])) as JobRow[];

        const nextRow = rows.find((r) => !skipJobIds?.has(mkJobId(r.id)));
        if (!nextRow) return undefined;

        const job = toJob(nextRow);
        const claimedJob = claimJob(job, workerId, new Date(), ttlMs);

        this.db
          .prepare(
            `UPDATE jobs
         SET status = @status,
             claimed_by = @claimed_by,
             claimed_at = @claimed_at,
             claim_expires_at = @claim_expires_at,
             attempts = @attempts
         WHERE id = @id`,
          )
          .run({
            status: claimedJob.status,
            claimed_by: claimedJob.claimedBy ?? null,
            claimed_at: claimedJob.claimedAt?.toISOString() ?? null,
            claim_expires_at: claimedJob.claimExpiresAt?.toISOString() ?? null,
            attempts: claimedJob.attempts,
            id: claimedJob.id,
          });

        return claimedJob;
      },
    );
  }

  enqueue(input: EnqueueJobInput): void {
    const repo = this.repos.findById(input.job.repoId);
    if (!repo || !repo.enabled) {
      throw new RepositoryNotApprovedError(input.job.repoId);
    }

    const existing = this.db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(input.job.id);
    if (existing) {
      throw new DuplicateJobIdError(input.job.id);
    }

    this.db
      .prepare(
        `INSERT INTO jobs (id, run_id, repo_id, issue_number, status, priority, attempts, claimed_by, created_at, claimed_at, started_at, completed_at, claim_expires_at)
       VALUES (@id, @run_id, @repo_id, @issue_number, @status, @priority, @attempts, @claimed_by, @created_at, @claimed_at, @started_at, @completed_at, @claim_expires_at)`,
      )
      .run({
        id: input.job.id,
        run_id: input.job.runId,
        repo_id: input.job.repoId,
        issue_number: input.job.issueNumber,
        status: input.job.status,
        priority: input.job.priority,
        attempts: input.job.attempts,
        claimed_by: input.job.claimedBy ?? null,
        created_at: input.job.createdAt.toISOString(),
        claimed_at: input.job.claimedAt?.toISOString() ?? null,
        started_at: input.job.startedAt?.toISOString() ?? null,
        completed_at: input.job.completedAt?.toISOString() ?? null,
        claim_expires_at: input.job.claimExpiresAt?.toISOString() ?? null,
      });
  }

  claimNext(input: ClaimNextInput): Job | undefined {
    return this.claimTx(input.workerId, input.skipJobIds, input.ttlMs, input.repoId);
  }

  releaseClaim(jobId: JobId): void {
    this.updateJob(jobId, (j) => unclaimJob(j));
  }

  resetToQueued(jobId: JobId): void {
    this.updateJob(jobId, (j) => resetJobToQueued(j));
  }

  markRunning(jobId: JobId, now: Date): void {
    this.updateJob(jobId, (j) => markJobRunning(j, now));
  }

  markSucceeded(jobId: JobId, now: Date): void {
    this.updateJob(jobId, (j) => markJobSucceeded(j, now));
  }

  markFailed(jobId: JobId, now: Date): void {
    this.updateJob(jobId, (j) => markJobFailed(j, now));
  }

  markCancelled(jobId: JobId, now: Date): void {
    this.updateJob(jobId, (j) => markJobCancelled(j, now));
  }

  listForRepo(repoId: RepositoryId): Job[] {
    const rows = this.db.prepare('SELECT * FROM jobs WHERE repo_id = ?').all(repoId) as JobRow[];
    return rows.map(toJob);
  }

  listActive(): Job[] {
    const rows = this.db
      .prepare(`SELECT * FROM jobs WHERE status IN ('claimed', 'running')`)
      .all() as JobRow[];
    return rows.map(toJob);
  }

  listForRun(runId: RunId): Job[] {
    const rows = this.db.prepare('SELECT * FROM jobs WHERE run_id = ?').all(runId) as JobRow[];
    return rows.map(toJob);
  }

  findById(jobId: JobId): Job | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined;
    return row ? toJob(row) : undefined;
  }

  findExpiredClaims(cutoff: Date): Job[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs
       WHERE status = 'claimed'
         AND claim_expires_at IS NOT NULL
         AND claim_expires_at < @cutoff`,
      )
      .all({ cutoff: cutoff.toISOString() }) as JobRow[];
    return rows.map(toJob);
  }

  reclaimStaleClaims(cutoff: Date): number {
    const reclaimTx = this.db.transaction((cutoffIso: string): number => {
      const expired = this.db
        .prepare(
          `SELECT id FROM jobs
         WHERE status = 'claimed'
           AND claim_expires_at IS NOT NULL
           AND claim_expires_at < @cutoff`,
        )
        .all({ cutoff: cutoffIso }) as Array<{ id: string }>;

      if (expired.length === 0) return 0;

      this.db
        .prepare(
          `UPDATE jobs
         SET status = 'queued',
             claimed_by = NULL,
             claimed_at = NULL,
             claim_expires_at = NULL
         WHERE status = 'claimed'
           AND claim_expires_at IS NOT NULL
           AND claim_expires_at < @cutoff`,
        )
        .run({ cutoff: cutoffIso });

      return expired.length;
    });
    return reclaimTx(cutoff.toISOString());
  }

  private updateJob(jobId: JobId, transition: (job: Job) => Job): void {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as
        | JobRow
        | undefined;
      if (!row) {
        throw new Error(`unknown job ${jobId}`);
      }
      const job = toJob(row);
      const updated = transition(job);
      this.db
        .prepare(
          `UPDATE jobs
         SET status = @status,
             attempts = @attempts,
             claimed_by = @claimed_by,
             claimed_at = @claimed_at,
             started_at = @started_at,
             completed_at = @completed_at,
             claim_expires_at = @claim_expires_at
         WHERE id = @id`,
        )
        .run({
          status: updated.status,
          attempts: updated.attempts,
          claimed_by: updated.claimedBy ?? null,
          claimed_at: updated.claimedAt?.toISOString() ?? null,
          started_at: updated.startedAt?.toISOString() ?? null,
          completed_at: updated.completedAt?.toISOString() ?? null,
          claim_expires_at: updated.claimExpiresAt?.toISOString() ?? null,
          id: updated.id,
        });
    });
    tx();
  }
}
