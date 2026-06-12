import { describe, it, expect } from 'vitest';
import { sortCommentsUnresolvedFirst, type PrReviewCommentDto } from '../pr-review';

const defaults: PrReviewCommentDto = {
  commentId: 1,
  prNumber: 5,
  path: 'a.ts',
  line: 1,
  reviewer: 'r',
  body: 'b',
  state: 'pending',
  attempts: 0,
  outcome: null,
  replyId: null,
  commitSha: null,
  commitVerified: false,
  replyVerified: false,
  buildVerified: false,
  blockedReason: null,
  lastPoll: 0,
  replyBody: null,
};

const c = (over: Partial<PrReviewCommentDto>): PrReviewCommentDto => ({ ...defaults, ...over });

describe('sortCommentsUnresolvedFirst', () => {
  it('orders pending > blocked > replied > processed, then by commentId', () => {
    const sorted = sortCommentsUnresolvedFirst([
      c({ commentId: 1, state: 'processed' }),
      c({ commentId: 4, state: 'replied' }),
      c({ commentId: 2, state: 'pending' }),
      c({ commentId: 5, state: 'replied' }),
      c({ commentId: 3, state: 'blocked' }),
    ]);
    expect(sorted.map((x) => x.commentId)).toEqual([2, 3, 4, 5, 1]);
  });

  it('returns empty array unchanged', () => {
    expect(sortCommentsUnresolvedFirst([])).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const input = [c({ commentId: 1, state: 'pending' }), c({ commentId: 2, state: 'processed' })];
    sortCommentsUnresolvedFirst(input);
    expect(input.map((x) => x.commentId)).toEqual([1, 2]);
  });
});
