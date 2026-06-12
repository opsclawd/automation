import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sortCommentsUnresolvedFirst, type PrReviewCommentDto } from '../pr-review';
import { listPrReview } from '../api-client';

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

describe('listPrReview', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns PrReviewData on successful response', async () => {
    const data = { comments: [], pollAttempts: [] };
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(data),
    });
    await expect(listPrReview('abc-123')).resolves.toEqual(data);
  });

  it('rejects with status code on non-ok response', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
    });
    await expect(listPrReview('abc-123')).rejects.toThrow(/500/);
  });

  it('propagates network errors', async () => {
    const error = new TypeError('Failed to fetch');
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(error);
    await expect(listPrReview('abc-123')).rejects.toThrow(error);
  });
});
