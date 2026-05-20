import { describe, expect, it } from 'vitest';
import { JobId, RepositoryId, RunId, WorkerId, IssueNumber } from '../ids.js';
import {
  createJob,
  claimJob,
  markJobRunning,
  markJobSucceeded,
  markJobFailed,
  markJobCancelled,
  JobStateError,
} from '../job.js';

const base = {
  id: JobId('j1'),
  runId: RunId('r1'),
  repoId: RepositoryId('repo1'),
  issueNumber: IssueNumber(7),
  priority: 0,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

describe('Job lifecycle', () => {
  it('createJob starts in queued', () => {
    const j = createJob(base);
    expect(j.status).toBe('queued');
    expect(j.attempts).toBe(0);
  });

  it('claimJob moves queued → claimed and assigns worker', () => {
    const j = claimJob(createJob(base), WorkerId('w1'), new Date());
    expect(j.status).toBe('claimed');
    expect(j.claimedBy).toBe('w1');
    expect(j.attempts).toBe(1);
  });

  it('claimJob refuses to claim a non-queued job', () => {
    const claimed = claimJob(createJob(base), WorkerId('w1'), new Date());
    expect(() => claimJob(claimed, WorkerId('w2'), new Date())).toThrow(JobStateError);
  });

  it('markJobRunning requires claimed', () => {
    expect(() => markJobRunning(createJob(base), new Date())).toThrow(JobStateError);
    const claimed = claimJob(createJob(base), WorkerId('w1'), new Date());
    expect(markJobRunning(claimed, new Date()).status).toBe('running');
  });

  it('markJobSucceeded sets status + completedAt', () => {
    let j = claimJob(createJob(base), WorkerId('w1'), new Date());
    j = markJobRunning(j, new Date());
    const done = markJobSucceeded(j, new Date('2026-01-02'));
    expect(done.status).toBe('succeeded');
    expect(done.completedAt).toEqual(new Date('2026-01-02'));
  });

  it('markJobFailed and markJobCancelled work from running', () => {
    let j = claimJob(createJob(base), WorkerId('w1'), new Date());
    j = markJobRunning(j, new Date());
    expect(markJobFailed(j, new Date()).status).toBe('failed');
    expect(markJobCancelled(j, new Date()).status).toBe('cancelled');
  });

  it('cannot cancel a terminal job', () => {
    let j = claimJob(createJob(base), WorkerId('w1'), new Date());
    j = markJobRunning(j, new Date());
    const failed = markJobFailed(j, new Date());
    expect(() => markJobCancelled(failed, new Date())).toThrow(JobStateError);
  });
});
