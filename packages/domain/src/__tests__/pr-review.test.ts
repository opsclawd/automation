import { describe, it, expect } from 'vitest';
import { RunId } from '../ids.js';
import {
  createPrReviewComment,
  markReplied,
  markProcessed,
  resetForRetry,
  blockComment,
  type PrReviewComment,
} from '../pr-review.js';

const base = () =>
  createPrReviewComment({
    runId: RunId('11111111-1111-1111-1111-111111111111'),
    prNumber: 42,
    commentId: 9001,
    path: 'src/a.ts',
    line: 10,
    reviewer: 'octocat',
    body: 'please fix',
    now: new Date('2026-06-04T00:00:00Z'),
  });

describe('PrReviewComment state machine', () => {
  it('starts pending with zero attempts', () => {
    const c = base();
    expect(c.state).toBe('pending');
    expect(c.attempts).toBe(0);
    expect(c.commitVerified).toBe(false);
    expect(c.replyVerified).toBe(false);
    expect(c.buildVerified).toBe(false);
  });

  it('pending -> replied records reply id and increments attempts', () => {
    const c = markReplied(base(), { replyId: 555, outcome: 'fixed', commitSha: 'abc123', poll: 1 });
    expect(c.state).toBe('replied');
    expect(c.replyId).toBe(555);
    expect(c.outcome).toBe('fixed');
    expect(c.commitSha).toBe('abc123');
    expect(c.attempts).toBe(1);
  });

  it('replied -> processed only when all verifications pass', () => {
    const replied = markReplied(base(), {
      replyId: 555,
      outcome: 'fixed',
      commitSha: 'abc',
      poll: 1,
    });
    const processed = markProcessed(replied, {
      commitVerified: true,
      replyVerified: true,
      buildVerified: true,
    });
    expect(processed.state).toBe('processed');
  });

  it('markProcessed throws if a verification is missing', () => {
    const replied = markReplied(base(), {
      replyId: 555,
      outcome: 'fixed',
      commitSha: 'abc',
      poll: 1,
    });
    expect(() =>
      markProcessed(replied, { commitVerified: true, replyVerified: false, buildVerified: true }),
    ).toThrow(/cannot mark.*processed/i);
  });

  it('resetForRetry sends replied back to pending (verification failed)', () => {
    const replied = markReplied(base(), {
      replyId: 555,
      outcome: 'fixed',
      commitSha: 'abc',
      poll: 1,
    });
    const retried = resetForRetry(replied, { poll: 2 });
    expect(retried.state).toBe('pending');
    expect(retried.attempts).toBe(1);
  });

  it('blockComment after 2 unresolved attempts', () => {
    let c: PrReviewComment = markReplied(base(), {
      replyId: 1,
      outcome: 'fixed',
      commitSha: 'a',
      poll: 1,
    });
    c = resetForRetry(c, { poll: 2 });
    c = markReplied(c, { replyId: 2, outcome: 'fixed', commitSha: 'b', poll: 2 });
    const blocked = blockComment(c, 'verification failed twice');
    expect(blocked.state).toBe('blocked');
    expect(blocked.blockedReason).toBe('verification failed twice');
  });

  it('isUnresolved returns true only for pending comments', async () => {
    const { isUnresolved } = await import('../pr-review.js');
    expect(isUnresolved(base())).toBe(true);
    const replied = markReplied(base(), { replyId: 1, outcome: 'fixed', commitSha: 'a', poll: 1 });
    expect(isUnresolved(replied)).toBe(false);
  });
});
