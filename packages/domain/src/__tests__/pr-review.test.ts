import { describe, it, expect } from 'vitest';
import { RunId } from '../ids.js';
import {
  createPrReviewComment,
  markReplied,
  markProcessed,
  blockComment,
  isUnresolved,
  CommentStateError,
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

  it('markReplied without commitSha clears it', () => {
    const c = markReplied(base(), { replyId: 555, outcome: 'fixed', poll: 1 });
    expect(c.commitSha).toBeUndefined();
  });

  it('markReplied throws if not in pending state', () => {
    const replied = markReplied(base(), { replyId: 1, outcome: 'fixed', poll: 1 });
    expect(() => markReplied(replied, { replyId: 2, outcome: 'fixed', poll: 2 })).toThrow(
      /cannot mark.*replied/i,
    );
  });

  it('replied -> processed only when all verifications pass (fixed outcome)', () => {
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

  it('replied -> processed for no_fix with only replyVerified', () => {
    const replied = markReplied(base(), {
      replyId: 555,
      outcome: 'no_fix',
      poll: 1,
    });
    const processed = markProcessed(replied, {
      commitVerified: false,
      replyVerified: true,
      buildVerified: false,
    });
    expect(processed.state).toBe('processed');
    expect(processed.commitVerified).toBe(false);
    expect(processed.buildVerified).toBe(false);
  });

  it('markProcessed throws if not in replied state', () => {
    expect(() =>
      markProcessed(base(), { commitVerified: true, replyVerified: true, buildVerified: true }),
    ).toThrow(/cannot mark.*processed/i);
  });

  it('markProcessed throws if a verification is missing (fixed outcome)', () => {
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

  it('markProcessed throws if replyVerified missing for no_fix', () => {
    const replied = markReplied(base(), {
      replyId: 555,
      outcome: 'no_fix',
      poll: 1,
    });
    expect(() =>
      markProcessed(replied, { commitVerified: false, replyVerified: false, buildVerified: false }),
    ).toThrow(/reply not verified/i);
  });

  it('blockComment from replied state', () => {
    const c = markReplied(base(), {
      replyId: 1,
      outcome: 'fixed',
      commitSha: 'a',
      poll: 1,
    });
    const blocked = blockComment(c, 'verification failed twice');
    expect(blocked.state).toBe('blocked');
    expect(blocked.blockedReason).toBe('verification failed twice');
  });

  it('blockComment from pending state (unresolved after repeated attempts)', () => {
    const blocked = blockComment(base(), 'agent could not resolve');
    expect(blocked.state).toBe('blocked');
    expect(blocked.blockedReason).toBe('agent could not resolve');
  });

  it('blockComment throws if in processed state', () => {
    const replied = markReplied(base(), {
      replyId: 1,
      outcome: 'fixed',
      commitSha: 'a',
      poll: 1,
    });
    const processed = markProcessed(replied, {
      commitVerified: true,
      replyVerified: true,
      buildVerified: true,
    });
    expect(() => blockComment(processed, 'reason')).toThrow(/cannot block/i);
  });

  it('isUnresolved returns true only for pending comments', () => {
    expect(isUnresolved(base())).toBe(true);
    const replied = markReplied(base(), { replyId: 1, outcome: 'fixed', commitSha: 'a', poll: 1 });
    expect(isUnresolved(replied)).toBe(false);
  });

  it('CommentStateError is instanceof Error', () => {
    const err = new CommentStateError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CommentStateError);
    expect(err.name).toBe('CommentStateError');
  });
});
