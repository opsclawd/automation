import { describe, it, expect } from 'vitest';
import { postPrReviewResultSchema, postPrReviewCommentSchema } from '../schemas/post-pr-review.js';

describe('postPrReviewResultSchema', () => {
  it('accepts a FULL_DONE manifest with a fixed comment', () => {
    const r = postPrReviewResultSchema.parse({
      outcome: 'ALL_DONE',
      comments: [{ commentId: 9001, action: 'fixed', replyBody: 'Done: changed X.' }],
    });
    expect(r.outcome).toBe('ALL_DONE');
    expect(r.comments[0].action).toBe('fixed');
    expect(r.comments[0].replyBody).toBe('Done: changed X.');
  });

  it('defaults comments to [] when omitted (NO_FIXES_NEEDED)', () => {
    const r = postPrReviewResultSchema.parse({ outcome: 'NO_FIXES_NEEDED' });
    expect(r.comments).toEqual([]);
  });

  it('accepts a blocked comment with optional blockedReason', () => {
    const r = postPrReviewResultSchema.parse({
      outcome: 'BLOCKED',
      comments: [
        { commentId: 42, action: 'blocked', replyBody: 'Cannot fix.', blockedReason: 'unsafe' },
      ],
    });
    expect(r.comments[0].blockedReason).toBe('unsafe');
  });

  it('rejects an unknown outcome', () => {
    expect(() => postPrReviewResultSchema.parse({ outcome: 'MAYBE' })).toThrow();
  });

  it('rejects a comment with empty replyBody', () => {
    expect(() =>
      postPrReviewResultSchema.parse({
        outcome: 'PARTIAL',
        comments: [{ commentId: 1, action: 'fixed', replyBody: '' }],
      }),
    ).toThrow();
  });
});

describe('postPrReviewCommentSchema', () => {
  it('accepts a no_fix comment without blockedReason', () => {
    const c = postPrReviewCommentSchema.parse({
      commentId: 10,
      action: 'no_fix',
      replyBody: 'Intentional.',
    });
    expect(c.action).toBe('no_fix');
    expect(c).not.toHaveProperty('blockedReason');
  });
});
