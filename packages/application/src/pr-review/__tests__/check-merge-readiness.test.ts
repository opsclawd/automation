import { describe, it, expect } from 'vitest';
import { RunId, createPrReviewComment, blockComment, markReplied, markProcessed } from '@ai-sdlc/domain';
import { FakePrReviewRepository } from '../../test-doubles/fake-pr-review-repository.js';
import { CheckMergeReadiness } from '../check-merge-readiness.js';

describe('CheckMergeReadiness', () => {
  const runId = RunId('11111111-1111-1111-1111-111111111111');
  const now = new Date();

  const baseComment = (id: number, body: string) =>
    createPrReviewComment({
      runId,
      prNumber: 42,
      commentId: id,
      path: 'a.ts',
      line: 1,
      reviewer: 'r',
      body,
      now,
    });

  it('returns ready=true when there are no comments', async () => {
    const prReviewRepo = new FakePrReviewRepository();
    const useCase = new CheckMergeReadiness({ prReviewRepo });
    const result = await useCase.execute(runId);
    expect(result.isReady).toBe(true);
    expect(result.blockedComments).toHaveLength(0);
    expect(result.unverifiedP1Comments).toHaveLength(0);
  });

  it('returns ready=true when all comments are processed', async () => {
    const prReviewRepo = new FakePrReviewRepository();
    const c1 = baseComment(1, 'P1 fix this');
    const c2 = baseComment(2, 'just a note');

    const r1 = markReplied(c1, { replyId: 101, outcome: 'fixed', poll: 1 });
    const p1 = markProcessed(r1, { commitVerified: true, replyVerified: true, buildVerified: true });

    const r2 = markReplied(c2, { replyId: 102, outcome: 'no_fix', poll: 1 });
    const p2 = markProcessed(r2, { commitVerified: false, replyVerified: true, buildVerified: false });

    prReviewRepo.upsertComment(p1);
    prReviewRepo.upsertComment(p2);

    const useCase = new CheckMergeReadiness({ prReviewRepo });
    const result = await useCase.execute(runId);
    expect(result.isReady).toBe(true);
  });

  it('returns ready=false when there is a blocked comment', async () => {
    const prReviewRepo = new FakePrReviewRepository();
    const c1 = blockComment(baseComment(1, 'P1 fix this'), 'failed too many times');
    prReviewRepo.upsertComment(c1);

    const useCase = new CheckMergeReadiness({ prReviewRepo });
    const result = await useCase.execute(runId);
    expect(result.isReady).toBe(false);
    expect(result.reason).toContain('1 blocked comment(s)');
    expect(result.blockedComments).toEqual([{ commentId: 1, reason: 'failed too many times' }]);
  });

  it('returns ready=false when there is an unverified P1 comment', async () => {
    const prReviewRepo = new FakePrReviewRepository();
    const c1 = baseComment(1, 'P1 major issue');
    prReviewRepo.upsertComment(c1);

    const useCase = new CheckMergeReadiness({ prReviewRepo });
    const result = await useCase.execute(runId);
    expect(result.isReady).toBe(false);
    expect(result.reason).toContain('1 unverified P1 comment(s)');
    expect(result.unverifiedP1Comments).toEqual([{ commentId: 1, severity: 'high' }]);
  });

  it('falls back to parsing severity from body if severity field is missing', async () => {
    const prReviewRepo = new FakePrReviewRepository();
    const c1 = baseComment(1, 'this is critical');
    // Simulate legacy record without severity field by stripping it
    const { severity: _, ...legacyComment } = c1;
    prReviewRepo.upsertComment(legacyComment as import('@ai-sdlc/domain').PrReviewComment);

    const useCase = new CheckMergeReadiness({ prReviewRepo });
    const result = await useCase.execute(runId);
    expect(result.isReady).toBe(false);
    expect(result.unverifiedP1Comments).toEqual([{ commentId: 1, severity: 'critical' }]);
  });

  it('returns ready=true if only P2/P3 comments are pending', async () => {
    const prReviewRepo = new FakePrReviewRepository();
    prReviewRepo.upsertComment(baseComment(1, 'P2 note'));
    prReviewRepo.upsertComment(baseComment(2, 'P3 nit'));
    prReviewRepo.upsertComment(baseComment(3, 'ordinary comment'));

    const useCase = new CheckMergeReadiness({ prReviewRepo });
    const result = await useCase.execute(runId);
    expect(result.isReady).toBe(true);
  });

  it('combines multiple reasons in the failure reason string', async () => {
    const prReviewRepo = new FakePrReviewRepository();
    prReviewRepo.upsertComment(blockComment(baseComment(1, 'nit'), 'blocked'));
    prReviewRepo.upsertComment(baseComment(2, 'P1 major issue'));

    const useCase = new CheckMergeReadiness({ prReviewRepo });
    const result = await useCase.execute(runId);
    expect(result.isReady).toBe(false);
    expect(result.reason).toBe('1 blocked comment(s), 1 unverified P1 comment(s)');
  });
});
