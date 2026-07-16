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
  unclaimJob,
  newClaimToken,
  generateJobOwnership,
  markJobRunningWithOwnership,
  markJobSucceededWithOwnership,
  markJobFailedWithOwnership,
  markJobCancelledWithOwnership,
  releaseClaimWithOwnership,
  resetJobToQueuedWithOwnership,
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

  it('claimJob sets claimExpiresAt when ttlMs is provided', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const j = claimJob(createJob(base), WorkerId('w1'), now, 5_000);
    expect(j.claimExpiresAt).toEqual(new Date('2026-01-01T00:00:05Z'));
  });

  it('claimJob omits claimExpiresAt when ttlMs is not provided', () => {
    const j = claimJob(createJob(base), WorkerId('w1'), new Date());
    expect(j.claimExpiresAt).toBeUndefined();
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

  it.each([
    ['succeeded', markJobSucceeded],
    ['failed', markJobFailed],
    ['cancelled', markJobCancelled],
  ])('cannot markJob%s from queued', (_, fn) => {
    expect(() => fn(createJob(base), new Date())).toThrow(JobStateError);
  });

  it.each([
    ['succeeded', markJobSucceeded],
    ['failed', markJobFailed],
    ['cancelled', markJobCancelled],
  ])('cannot markJob%s from claimed', (_, fn) => {
    const claimed = claimJob(createJob(base), WorkerId('w1'), new Date());
    expect(() => fn(claimed, new Date())).toThrow(JobStateError);
  });
});

describe('Job claim ownership generations', () => {
  it('newClaimToken generates a unique token each call', () => {
    const t1 = newClaimToken();
    const t2 = newClaimToken();
    expect(typeof t1).toBe('string');
    expect(t1.length).toBeGreaterThan(0);
    expect(t1).not.toBe(t2);
  });

  it('claim creates a fresh ownership generation', () => {
    const j = createJob(base);
    const now = new Date();
    const claimed = claimJob(j, WorkerId('w1'), now);
    expect(claimed.claimToken).toBeDefined();
    expect(typeof claimed.claimToken).toBe('string');

    // Claim again - should get a different token
    const reclaimed = claimJob({ ...j, status: 'queued' }, WorkerId('w1'), now);
    expect(reclaimed.claimToken).not.toBe(claimed.claimToken);
  });

  it('generateJobOwnership returns jobId, workerId, and claimToken', () => {
    const j = createJob(base);
    const now = new Date();
    const claimed = claimJob(j, WorkerId('w1'), now);
    const ownership = generateJobOwnership(claimed, WorkerId('w1'));
    expect(ownership.jobId).toBe(j.id);
    expect(ownership.workerId).toBe('w1');
    expect(ownership.claimToken).toBe(claimed.claimToken);
  });

  it('unclaimJob clears claimToken', () => {
    const j = createJob(base);
    const claimed = claimJob(j, WorkerId('w1'), new Date());
    expect(claimed.claimToken).toBeDefined();
    const unclaimed = unclaimJob(claimed);
    expect(unclaimed.claimToken).toBeUndefined();
  });

  it('stale claim token cannot mark reclaimed job running', () => {
    const j = createJob(base);
    const now = new Date();
    // 1st claim
    const claimed1 = claimJob(j, WorkerId('w1'), now);
    const ownership1 = generateJobOwnership(claimed1, WorkerId('w1'));
    // Reclaim/reclaim sequence: unclaim then claim again (simulating reclaimed by another claim)
    const unclaimed = unclaimJob(claimed1);
    const claimed2 = claimJob(unclaimed, WorkerId('w2'), now);

    // Verify stale ownership1 cannot mark claimed2 running
    expect(() => markJobRunningWithOwnership(claimed2, ownership1, now)).toThrow(JobStateError);
  });

  it('stale claim token cannot settle reclaimed job', () => {
    const j = createJob(base);
    const now = new Date();
    // 1st claim
    const claimed1 = claimJob(j, WorkerId('w1'), now);
    const ownership1 = generateJobOwnership(claimed1, WorkerId('w1'));
    // Reclaim/reclaim sequence: unclaim then claim again
    const unclaimed = unclaimJob(claimed1);
    const claimed2 = claimJob(unclaimed, WorkerId('w2'), now);
    const running2 = markJobRunning(claimed2, now);

    // Verify stale ownership1 cannot succeed/fail/cancel running2
    expect(() => markJobSucceededWithOwnership(running2, ownership1, now)).toThrow(JobStateError);
    expect(() => markJobFailedWithOwnership(running2, ownership1, now)).toThrow(JobStateError);
    expect(() => markJobCancelledWithOwnership(running2, ownership1, now)).toThrow(JobStateError);
  });

  it('stale claim token cannot release or shutdown-requeue reclaimed job', () => {
    const j = createJob(base);
    const now = new Date();
    // 1st claim
    const claimed1 = claimJob(j, WorkerId('w1'), now);
    const ownership1 = generateJobOwnership(claimed1, WorkerId('w1'));
    // Reclaim/reclaim sequence: unclaim then claim again
    const unclaimed = unclaimJob(claimed1);
    const claimed2 = claimJob(unclaimed, WorkerId('w2'), now);

    // Verify stale ownership1 cannot release claimed2
    expect(() => releaseClaimWithOwnership(claimed2, ownership1)).toThrow(JobStateError);
    // Verify stale ownership1 cannot reset to queued claimed2
    expect(() => resetJobToQueuedWithOwnership(claimed2, ownership1)).toThrow(JobStateError);
  });
});
