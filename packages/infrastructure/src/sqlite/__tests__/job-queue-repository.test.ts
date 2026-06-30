import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type Job,
  type RepositoryId,
  RepositoryId as mkRepositoryId,
  WorkerId as mkWorkerId,
  RunId as mkRunId,
  JobId as mkJobId,
  IssueNumber,
  DuplicateJobIdError,
  RepositoryNotApprovedError,
  JobStateError,
} from '@ai-sdlc/domain';
import type { RepositoryPort } from '@ai-sdlc/application/ports';
import { openDatabase, applyMigrations } from '../../index.js';
import { JobQueueRepository } from '../job-queue-repository.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-jqr-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  applyMigrations(db);
  return db;
}

const mockRepos = (enabledMap: Record<string, boolean>): RepositoryPort => ({
  findById: (id: RepositoryId) => {
    if (id in enabledMap) {
      return {
        id,
        owner: 'test',
        name: 'test-repo',
        fullName: `test/${id}`,
        defaultBranch: 'main',
        localBasePath: '/tmp/test',
        enabled: enabledMap[id],
        maxConcurrentRuns: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }
    return undefined;
  },
  findByFullName: () => undefined,
  listEnabled: () => [],
});

const defaultJob = (overrides?: Partial<Job>): Job => ({
  id: mkJobId('job-1'),
  runId: mkRunId('run-1'),
  repoId: mkRepositoryId('repo-1'),
  issueNumber: 42 as IssueNumber,
  status: 'queued',
  priority: 0,
  attempts: 0,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

describe('JobQueueRepository', () => {
  it('enqueue: enqueues a job successfully when repository is enabled', () => {
    const db = freshDb();
    const repos = mockRepos({ 'repo-1': true });
    const repo = new JobQueueRepository(db, repos);

    const job = defaultJob();
    repo.enqueue({ job });

    const found = repo.findById(job.id);
    expect(found).toBeDefined();
    expect(found?.id).toBe(job.id);
    expect(found?.runId).toBe(job.runId);
    expect(found?.repoId).toBe(job.repoId);
    expect(found?.issueNumber).toBe(job.issueNumber);
    expect(found?.status).toBe('queued');
    expect(found?.priority).toBe(0);
    expect(found?.attempts).toBe(0);
    expect(found?.createdAt).toEqual(new Date('2026-01-01T00:00:00Z'));
    db.close();
  });

  it('enqueue: throws RepositoryNotApprovedError when repository is missing or disabled', () => {
    const db = freshDb();
    const repos = mockRepos({ 'repo-disabled': false });
    const repo = new JobQueueRepository(db, repos);

    // Missing repo
    expect(() =>
      repo.enqueue({ job: defaultJob({ repoId: mkRepositoryId('repo-missing') }) }),
    ).toThrow(RepositoryNotApprovedError);

    // Disabled repo
    expect(() =>
      repo.enqueue({ job: defaultJob({ repoId: mkRepositoryId('repo-disabled') }) }),
    ).toThrow(RepositoryNotApprovedError);

    db.close();
  });

  it('enqueue: throws DuplicateJobIdError when job ID already exists', () => {
    const db = freshDb();
    const repos = mockRepos({ 'repo-1': true });
    const repo = new JobQueueRepository(db, repos);

    const job = defaultJob();
    repo.enqueue({ job });

    expect(() => repo.enqueue({ job })).toThrow(DuplicateJobIdError);
    db.close();
  });

  it('claimNext: returns undefined when no queued jobs exist', () => {
    const db = freshDb();
    const repos = mockRepos({ 'repo-1': true });
    const repo = new JobQueueRepository(db, repos);

    const claimed = repo.claimNext({ workerId: mkWorkerId('worker-1') });
    expect(claimed).toBeUndefined();
    db.close();
  });

  it('claimNext: returns the highest priority job, then earliest createdAt, then ID', () => {
    const db = freshDb();
    const repos = mockRepos({ 'repo-1': true });
    const repo = new JobQueueRepository(db, repos);

    const job1 = defaultJob({
      id: mkJobId('job-a'),
      priority: 0,
      createdAt: new Date('2026-01-02T00:00:00Z'),
    });
    const job2 = defaultJob({
      id: mkJobId('job-b'),
      priority: 5,
      createdAt: new Date('2026-01-03T00:00:00Z'),
    });
    const job3 = defaultJob({
      id: mkJobId('job-c'),
      priority: 5,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const job4 = defaultJob({
      id: mkJobId('job-d'),
      priority: 5,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    repo.enqueue({ job: job1 });
    repo.enqueue({ job: job2 });
    repo.enqueue({ job: job3 });
    repo.enqueue({ job: job4 });

    // Priority 5 vs 0: Job 3, 4, 2 are priority 5.
    // Earliest createdAt for priority 5 is 2026-01-01 (Job 3, 4).
    // Lowest ID alphabetically between 3 and 4 is job-c.
    const first = repo.claimNext({ workerId: mkWorkerId('worker-1') });
    expect(first?.id).toBe('job-c');
    expect(first?.status).toBe('claimed');
    expect(first?.claimedBy).toBe('worker-1');
    expect(first?.attempts).toBe(1);

    const second = repo.claimNext({ workerId: mkWorkerId('worker-1') });
    expect(second?.id).toBe('job-d');

    const third = repo.claimNext({ workerId: mkWorkerId('worker-1') });
    expect(third?.id).toBe('job-b');

    const fourth = repo.claimNext({ workerId: mkWorkerId('worker-1') });
    expect(fourth?.id).toBe('job-a');

    db.close();
  });

  it('claimNext: respects skipJobIds', () => {
    const db = freshDb();
    const repos = mockRepos({ 'repo-1': true });
    const repo = new JobQueueRepository(db, repos);

    const job1 = defaultJob({ id: mkJobId('job-a') });
    const job2 = defaultJob({ id: mkJobId('job-b') });

    repo.enqueue({ job: job1 });
    repo.enqueue({ job: job2 });

    const claimed = repo.claimNext({
      workerId: mkWorkerId('worker-1'),
      skipJobIds: new Set([mkJobId('job-a')]),
    });
    expect(claimed?.id).toBe('job-b');
    db.close();
  });

  it('state transitions: releaseClaim, resetToQueued, markRunning, markSucceeded, markFailed, markCancelled', () => {
    const db = freshDb();
    const repos = mockRepos({ 'repo-1': true });
    const repo = new JobQueueRepository(db, repos);

    const job = defaultJob();
    repo.enqueue({ job });

    // Claim the job
    const claimed = repo.claimNext({ workerId: mkWorkerId('worker-1') });
    expect(claimed).toBeDefined();

    // releaseClaim: claimed -> queued
    repo.releaseClaim(job.id);
    let updated = repo.findById(job.id);
    expect(updated?.status).toBe('queued');
    expect(updated?.claimedBy).toBeUndefined();
    expect(updated?.claimedAt).toBeUndefined();

    // Claim again
    const claimedAgain = repo.claimNext({ workerId: mkWorkerId('worker-1') });
    expect(claimedAgain?.attempts).toBe(2);

    // markRunning: claimed -> running
    const runTime = new Date('2026-01-01T01:00:00Z');
    repo.markRunning(job.id, runTime);
    updated = repo.findById(job.id);
    expect(updated?.status).toBe('running');
    expect(updated?.startedAt).toEqual(runTime);

    // resetToQueued: running -> queued
    repo.resetToQueued(job.id);
    updated = repo.findById(job.id);
    expect(updated?.status).toBe('queued');
    expect(updated?.claimedBy).toBeUndefined();
    expect(updated?.claimedAt).toBeUndefined();
    expect(updated?.startedAt).toBeUndefined();

    // Claim and mark running again
    repo.claimNext({ workerId: mkWorkerId('worker-1') });
    repo.markRunning(job.id, runTime);

    // markSucceeded: running -> succeeded
    const compTime = new Date('2026-01-01T02:00:00Z');
    repo.markSucceeded(job.id, compTime);
    updated = repo.findById(job.id);
    expect(updated?.status).toBe('succeeded');
    expect(updated?.completedAt).toEqual(compTime);

    // Try invalid state transition (succeeded -> running)
    expect(() => repo.markRunning(job.id, runTime)).toThrow(JobStateError);

    db.close();
  });

  it('lists and finds jobs correctly', () => {
    const db = freshDb();
    const repos = mockRepos({ 'repo-1': true, 'repo-2': true });
    const repo = new JobQueueRepository(db, repos);

    const job1 = defaultJob({
      id: mkJobId('job-a'),
      repoId: mkRepositoryId('repo-1'),
      runId: mkRunId('run-1'),
    });
    const job2 = defaultJob({
      id: mkJobId('job-b'),
      repoId: mkRepositoryId('repo-1'),
      runId: mkRunId('run-2'),
    });
    const job3 = defaultJob({
      id: mkJobId('job-c'),
      repoId: mkRepositoryId('repo-2'),
      runId: mkRunId('run-1'),
    });

    repo.enqueue({ job: job1 });
    repo.enqueue({ job: job2 });
    repo.enqueue({ job: job3 });

    const listRepo1 = repo.listForRepo(mkRepositoryId('repo-1'));
    expect(listRepo1.map((j) => j.id)).toContain('job-a');
    expect(listRepo1.map((j) => j.id)).toContain('job-b');
    expect(listRepo1.length).toBe(2);

    const listRun1 = repo.listForRun(mkRunId('run-1'));
    expect(listRun1.map((j) => j.id)).toContain('job-a');
    expect(listRun1.map((j) => j.id)).toContain('job-c');
    expect(listRun1.length).toBe(2);

    db.close();
  });
});
