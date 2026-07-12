import { describe, it, expect } from 'vitest';
import { RunId } from '../ids.js';
import {
  createPrReviewComment,
  markReplied,
  markProcessed,
  resetForRetry,
  blockComment,
  isUnresolved,
  parseSeverity,
  CommentStateError,
} from '../pr-review.js';
import type { PrReviewCommentAttempt } from '../pr-review.js';

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

describe('pr-review domain helpers', () => {
  describe('parseSeverity', () => {
    it('detects critical severity', () => {
      expect(parseSeverity('this is critical')).toBe('critical');
      expect(parseSeverity('P0 issue')).toBe('critical');
    });

    it('detects high severity', () => {
      expect(parseSeverity('high priority')).toBe('high');
      expect(parseSeverity('P1 finding')).toBe('high');
    });

    it('detects medium severity', () => {
      expect(parseSeverity('medium severity')).toBe('medium');
      expect(parseSeverity('P2 note')).toBe('medium');
    });

    it('detects low severity', () => {
      expect(parseSeverity('low impact')).toBe('low');
      expect(parseSeverity('P3 nit')).toBe('low');
    });

    it('returns undefined for unknown body', () => {
      expect(parseSeverity('just a comment')).toBeUndefined();
    });
  });

  it('populates severity from body in createPrReviewComment', () => {
    const c = createPrReviewComment({
      runId: RunId('11111111-1111-1111-1111-111111111111'),
      prNumber: 1,
      commentId: 1,
      path: 'a.ts',
      line: 1,
      reviewer: 'r',
      body: 'this is critical',
      now: new Date(),
    });
    expect(c.severity).toBe('critical');
  });
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

  it('resetForRetry sends replied back to pending and clears stale fields', () => {
    const replied = markReplied(base(), {
      replyId: 555,
      outcome: 'fixed',
      commitSha: 'abc',
      poll: 1,
    });
    const retried = resetForRetry(replied, { poll: 2 });
    expect(retried.state).toBe('pending');
    expect(retried.attempts).toBe(1);
    expect(retried.replyId).toBeUndefined();
    expect(retried.outcome).toBeUndefined();
    expect(retried.commitSha).toBeUndefined();
    expect(retried.blockedReason).toBeUndefined();
    expect(retried.commitVerified).toBe(false);
    expect(retried.replyVerified).toBe(false);
    expect(retried.buildVerified).toBe(false);
  });

  it('resetForRetry throws if not in replied state', () => {
    expect(() => resetForRetry(base(), { poll: 1 })).toThrow(/cannot reset.*retry/i);
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

  it('markProcessed throws CommentStateError when buildVerified is false on a fixed outcome (#621 trap)', () => {
    const replied = markReplied(base(), {
      replyId: 555,
      outcome: 'fixed',
      commitSha: 'abc',
      poll: 1,
    });
    let caught: unknown;
    try {
      markProcessed(replied, {
        commitVerified: true,
        replyVerified: true,
        buildVerified: false,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CommentStateError);
    expect(String(caught)).toMatch(/build.*false|verification incomplete/);
    // Side-effect guard: the original comment object must NOT be mutated
    // by a failed markProcessed call.
    expect(replied.state).toBe('replied');
    expect(replied.buildVerified).toBe(false);
  });
});

describe('PrReviewCommentAttempt', () => {
  const runId = RunId('11111111-1111-1111-1111-111111111111');

  it('can be constructed with all required fields', () => {
    const attempt: PrReviewCommentAttempt = {
      attemptId: 'attempt-1',
      runId,
      commentId: 100,
      retryNumber: 0,
      startHead: 'abc123',
      reviewMode: 'post-fix',
      promptPath: '/prompts/review-100.md',
      resultArtifactPath: '/artifacts/result-100.md',
      action: 'review',
      createdAt: new Date('2026-07-12T00:00:00Z'),
    };
    expect(attempt.attemptId).toBe('attempt-1');
    expect(attempt.runId).toBe(runId);
    expect(attempt.retryNumber).toBe(0);
    expect(attempt.startHead).toBe('abc123');
    expect(attempt.disposition).toBeUndefined();
  });

  it('can be constructed with optional fields', () => {
    const attempt: PrReviewCommentAttempt = {
      attemptId: 'attempt-2',
      runId,
      commentId: 100,
      retryNumber: 1,
      startHead: 'abc123',
      completedHead: 'def456',
      reviewMode: 'post-fix',
      promptPath: '/prompts/review-100.md',
      resultArtifactPath: '/artifacts/result-100.md',
      action: 'verify',
      verifierFeedback: 'commit verified',
      buildFeedback: 'build passed',
      disposition: 'success',
      createdAt: new Date('2026-07-12T00:01:00Z'),
    };
    expect(attempt.completedHead).toBe('def456');
    expect(attempt.verifierFeedback).toBe('commit verified');
    expect(attempt.buildFeedback).toBe('build passed');
    expect(attempt.disposition).toBe('success');
  });

  it('attempts field on PrReviewComment is a number (lifecycle summary), not an audit log', () => {
    const c = createPrReviewComment({
      runId,
      prNumber: 42,
      commentId: 9001,
      path: 'src/a.ts',
      line: 10,
      reviewer: 'octocat',
      body: 'please fix',
      now: new Date('2026-06-04T00:00:00Z'),
    });
    expect(typeof c.attempts).toBe('number');
    expect(c.attempts).toBe(0);
  });
});
