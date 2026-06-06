import { describe, it, expect } from 'vitest';
import { RunId, createPrReviewComment, markReplied } from '@ai-sdlc/domain';
import { FakePrReviewRepository } from '../test-doubles/fake-pr-review-repository.js';

const runId = RunId('22222222-2222-2222-2222-222222222222');

describe('FakePrReviewRepository', () => {
  it('upserts and reads back a comment by id', () => {
    const repo = new FakePrReviewRepository();
    const c = createPrReviewComment({
      runId,
      prNumber: 7,
      commentId: 100,
      path: 'a.ts',
      line: 1,
      reviewer: 'r',
      body: 'b',
      now: new Date(),
    });
    repo.upsertComment(c);
    expect(repo.getComment(runId, 100)?.state).toBe('pending');
    repo.upsertComment(markReplied(c, { replyId: 9, outcome: 'fixed', poll: 1 }));
    expect(repo.getComment(runId, 100)?.state).toBe('replied');
    expect(repo.listComments(runId)).toHaveLength(1);
  });

  it('tracks the latest poll attempt', () => {
    const repo = new FakePrReviewRepository();
    repo.insertPollAttempt({
      id: 'p1',
      runId,
      prNumber: 7,
      pollNumber: 1,
      status: 'running',
      commentsFetched: 0,
      commentsProcessed: 0,
      startedAt: new Date('2026-06-04T00:00:00Z'),
    });
    repo.insertPollAttempt({
      id: 'p2',
      runId,
      prNumber: 7,
      pollNumber: 2,
      status: 'running',
      commentsFetched: 0,
      commentsProcessed: 0,
      startedAt: new Date('2026-06-04T01:00:00Z'),
    });
    expect(repo.latestPollAttempt(runId)?.pollNumber).toBe(2);
  });

  it('inserts and lists replies', () => {
    const repo = new FakePrReviewRepository();
    repo.insertReply({
      id: 'r1',
      runId,
      prNumber: 7,
      commentId: 100,
      body: 'done',
      postedAt: new Date(),
      verified: false,
    });
    expect(repo.listReplies(runId)).toHaveLength(1);
  });

  it('returns the most-recently-inserted attempt for duplicate poll numbers', () => {
    const repo = new FakePrReviewRepository();
    const a1 = {
      id: 'p1',
      runId,
      prNumber: 7,
      pollNumber: 2,
      status: 'running' as const,
      commentsFetched: 0,
      commentsProcessed: 0,
      startedAt: new Date('2026-06-04T00:00:00Z'),
    };
    const a2 = {
      id: 'p2',
      runId,
      prNumber: 7,
      pollNumber: 2,
      status: 'running' as const,
      commentsFetched: 0,
      commentsProcessed: 0,
      startedAt: new Date('2026-06-04T01:00:00Z'),
    };
    repo.insertPollAttempt(a1);
    repo.insertPollAttempt(a2);
    expect(repo.latestPollAttempt(runId)).toBe(a2);
  });

  it('listPollAttempts preserves insertion order for the same run', () => {
    const repo = new FakePrReviewRepository();
    const attempts = [
      {
        id: 'p1',
        runId,
        prNumber: 7,
        pollNumber: 1,
        status: 'running' as const,
        commentsFetched: 0,
        commentsProcessed: 0,
        startedAt: new Date('2026-06-04T00:00:00Z'),
      },
      {
        id: 'p2',
        runId,
        prNumber: 7,
        pollNumber: 2,
        status: 'running' as const,
        commentsFetched: 0,
        commentsProcessed: 0,
        startedAt: new Date('2026-06-04T01:00:00Z'),
      },
      {
        id: 'p3',
        runId,
        prNumber: 7,
        pollNumber: 3,
        status: 'running' as const,
        commentsFetched: 0,
        commentsProcessed: 0,
        startedAt: new Date('2026-06-04T02:00:00Z'),
      },
    ];
    for (const a of attempts) repo.insertPollAttempt(a);
    const listed = repo.listPollAttempts(runId);
    expect(listed.map((a) => a.id)).toEqual(['p1', 'p2', 'p3']);
  });

  it('updatePollAttempt replaces an existing attempt', () => {
    const repo = new FakePrReviewRepository();
    repo.insertPollAttempt({
      id: 'p1',
      runId,
      prNumber: 7,
      pollNumber: 1,
      status: 'running',
      commentsFetched: 2,
      commentsProcessed: 0,
      startedAt: new Date('2026-06-04T00:00:00Z'),
    });
    repo.updatePollAttempt({
      id: 'p1',
      runId,
      prNumber: 7,
      pollNumber: 1,
      status: 'completed',
      commentsFetched: 2,
      commentsProcessed: 2,
      startedAt: new Date('2026-06-04T00:00:00Z'),
      completedAt: new Date('2026-06-04T00:05:00Z'),
      terminalState: 'all_resolved',
    });
    expect(repo.latestPollAttempt(runId)?.status).toBe('completed');
    expect(repo.latestPollAttempt(runId)?.terminalState).toBe('all_resolved');
    expect(repo.listPollAttempts(runId)).toHaveLength(1);
  });
});
