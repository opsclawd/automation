import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  RunId,
  createPrReviewComment,
  markReplied,
  type PollAttempt,
  type PrReviewCommentAttempt,
} from '@ai-sdlc/domain';
import { openDatabase, applyMigrations } from '../../index.js';
import { PrReviewRepository } from '../pr-review-repository.js';

const RUN_UUID = '33333333-3333-3333-3333-333333333333';
const runId = RunId(RUN_UUID);

function seedRun(db: ReturnType<typeof openDatabase>): void {
  db.prepare(
    `INSERT INTO runs (uuid, display_id, issue_number, type, status, started_at, completed_phases)
     VALUES (?, 'run-x', 7, 'issue_to_pr', 'running', datetime('now'), '[]')`,
  ).run(RUN_UUID);
}

describe('PrReviewRepository', () => {
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    db = openDatabase(':memory:');
    applyMigrations(db);
    seedRun(db);
  });

  afterEach(() => {
    db.close();
  });

  it('round-trips a comment through state changes', () => {
    const repo = new PrReviewRepository(db);
    const c = createPrReviewComment({
      runId,
      prNumber: 7,
      commentId: 100,
      path: 'a.ts',
      line: 3,
      reviewer: 'r',
      body: 'fix',
      now: new Date('2026-06-04T00:00:00Z'),
    });
    repo.upsertComment(c);
    expect(repo.getComment(runId, 100)?.state).toBe('pending');

    repo.upsertComment(
      markReplied(c, { replyId: 9, outcome: 'fixed', commitSha: 'sha1', poll: 1 }),
    );
    const back = repo.getComment(runId, 100)!;
    expect(back.state).toBe('replied');
    expect(back.replyId).toBe(9);
    expect(back.commitSha).toBe('sha1');
    expect(back.attempts).toBe(1);
  });

  it('listComments returns all comments for a run', () => {
    const repo = new PrReviewRepository(db);
    repo.upsertComment(
      createPrReviewComment({
        runId,
        prNumber: 7,
        commentId: 100,
        path: 'a.ts',
        line: 1,
        reviewer: 'r1',
        body: 'b1',
        now: new Date(),
      }),
    );
    repo.upsertComment(
      createPrReviewComment({
        runId,
        prNumber: 7,
        commentId: 200,
        path: 'b.ts',
        line: 2,
        reviewer: 'r2',
        body: 'b2',
        now: new Date(),
      }),
    );
    expect(repo.listComments(runId)).toHaveLength(2);
  });

  it('inserts and lists replies', () => {
    const repo = new PrReviewRepository(db);
    repo.upsertComment(
      createPrReviewComment({
        runId,
        prNumber: 7,
        commentId: 100,
        path: 'a.ts',
        line: 1,
        reviewer: 'r',
        body: 'b',
        now: new Date(),
      }),
    );
    repo.insertReply({
      id: 'r1',
      runId,
      prNumber: 7,
      commentId: 100,
      body: 'done',
      postedAt: new Date('2026-06-04T00:00:00Z'),
      verified: true,
    });
    const replies = repo.listReplies(runId);
    expect(replies).toHaveLength(1);
    expect(replies[0].verified).toBe(true);
  });

  it('records and updates poll attempts', () => {
    const repo = new PrReviewRepository(db);
    const attempt: PollAttempt = {
      id: 'p1',
      runId,
      prNumber: 7,
      pollNumber: 1,
      status: 'running',
      commentsFetched: 2,
      commentsProcessed: 0,
      startedAt: new Date('2026-06-04T00:00:00Z'),
    };
    repo.insertPollAttempt(attempt);
    repo.updatePollAttempt({
      ...attempt,
      status: 'completed',
      commentsProcessed: 2,
      completedAt: new Date('2026-06-04T00:05:00Z'),
      terminalState: 'all_resolved',
    });
    expect(repo.latestPollAttempt(runId)?.status).toBe('completed');
    expect(repo.latestPollAttempt(runId)?.terminalState).toBe('all_resolved');
    expect(repo.listPollAttempts(runId)).toHaveLength(1);
  });

  it('getComment returns undefined for unknown comment', () => {
    const repo = new PrReviewRepository(db);
    expect(repo.getComment(runId, 999)).toBeUndefined();
  });

  it('latestPollAttempt returns undefined when no polls exist', () => {
    const repo = new PrReviewRepository(db);
    expect(repo.latestPollAttempt(runId)).toBeUndefined();
  });

  it('appendCommentAttempt and listCommentAttempts round-trips', () => {
    const repo = new PrReviewRepository(db);
    repo.upsertComment(
      createPrReviewComment({
        runId,
        prNumber: 7,
        commentId: 100,
        path: 'a.ts',
        line: 1,
        reviewer: 'r',
        body: 'fix',
        now: new Date(),
      }),
    );
    const attempt: PrReviewCommentAttempt = {
      attemptId: 'a1',
      runId,
      commentId: 100,
      retryNumber: 0,
      startHead: 'abc123',
      reviewMode: 'post-fix',
      promptPath: '/prompts/review.md',
      resultArtifactPath: '/artifacts/result.md',
      action: 'review',
      createdAt: new Date('2026-07-12T00:00:00Z'),
    };
    repo.appendCommentAttempt(attempt);
    const listed = repo.listCommentAttempts(runId, 100);
    expect(listed).toHaveLength(1);
    expect(listed[0].attemptId).toBe('a1');
    expect(listed[0].startHead).toBe('abc123');
    expect(listed[0].reviewMode).toBe('post-fix');
  });

  it('appendCommentAttempt with optional fields round-trips', () => {
    const repo = new PrReviewRepository(db);
    repo.upsertComment(
      createPrReviewComment({
        runId,
        prNumber: 7,
        commentId: 100,
        path: 'a.ts',
        line: 1,
        reviewer: 'r',
        body: 'fix',
        now: new Date(),
      }),
    );
    const attempt: PrReviewCommentAttempt = {
      attemptId: 'a2',
      runId,
      commentId: 100,
      retryNumber: 0,
      startHead: 'abc123',
      completedHead: 'def456',
      reviewMode: 'post-fix',
      promptPath: '/prompts/review.md',
      resultArtifactPath: '/artifacts/result.md',
      action: 'verify',
      verifierFeedback: 'commit verified',
      buildFeedback: 'build passed',
      disposition: 'success',
      createdAt: new Date('2026-07-12T00:00:00Z'),
    };
    repo.appendCommentAttempt(attempt);
    const listed = repo.listCommentAttempts(runId, 100);
    expect(listed[0].completedHead).toBe('def456');
    expect(listed[0].verifierFeedback).toBe('commit verified');
    expect(listed[0].buildFeedback).toBe('build passed');
    expect(listed[0].disposition).toBe('success');
  });

  it('appendCommentAttempt rejects duplicate retry number', () => {
    const repo = new PrReviewRepository(db);
    repo.upsertComment(
      createPrReviewComment({
        runId,
        prNumber: 7,
        commentId: 100,
        path: 'a.ts',
        line: 1,
        reviewer: 'r',
        body: 'fix',
        now: new Date(),
      }),
    );
    const attempt: PrReviewCommentAttempt = {
      attemptId: 'a1',
      runId,
      commentId: 100,
      retryNumber: 0,
      startHead: 'abc123',
      reviewMode: 'post-fix',
      promptPath: '/prompts/review.md',
      resultArtifactPath: '/artifacts/result.md',
      action: 'review',
      createdAt: new Date('2026-07-12T00:00:00Z'),
    };
    repo.appendCommentAttempt(attempt);
    expect(() => repo.appendCommentAttempt({ ...attempt, attemptId: 'a2' })).toThrow();
  });

  it('listCommentAttempts returns attempts for specific comment', () => {
    const repo = new PrReviewRepository(db);
    repo.upsertComment(
      createPrReviewComment({
        runId,
        prNumber: 7,
        commentId: 100,
        path: 'a.ts',
        line: 1,
        reviewer: 'r',
        body: 'fix',
        now: new Date(),
      }),
    );
    repo.upsertComment(
      createPrReviewComment({
        runId,
        prNumber: 7,
        commentId: 200,
        path: 'b.ts',
        line: 2,
        reviewer: 'r',
        body: 'fix',
        now: new Date(),
      }),
    );
    repo.appendCommentAttempt({
      attemptId: 'a1',
      runId,
      commentId: 100,
      retryNumber: 0,
      startHead: 'abc',
      reviewMode: 'post-fix',
      promptPath: '/p.md',
      resultArtifactPath: '/r.md',
      action: 'review',
      createdAt: new Date('2026-07-12T00:00:00Z'),
    });
    repo.appendCommentAttempt({
      attemptId: 'a2',
      runId,
      commentId: 200,
      retryNumber: 0,
      startHead: 'def',
      reviewMode: 'post-fix',
      promptPath: '/p2.md',
      resultArtifactPath: '/r2.md',
      action: 'review',
      createdAt: new Date('2026-07-12T00:00:00Z'),
    });
    expect(repo.listCommentAttempts(runId, 100)).toHaveLength(1);
    expect(repo.listCommentAttempts(runId, 200)).toHaveLength(1);
    expect(repo.listCommentAttempts(runId, 999)).toHaveLength(0);
  });

  it('listCommentAttempts is empty for legacy comment with no attempts', () => {
    const repo = new PrReviewRepository(db);
    repo.upsertComment(
      createPrReviewComment({
        runId,
        prNumber: 7,
        commentId: 100,
        path: 'a.ts',
        line: 1,
        reviewer: 'r',
        body: 'fix',
        now: new Date(),
      }),
    );
    expect(repo.listCommentAttempts(runId, 100)).toHaveLength(0);
  });

  it('listCommentAttempts orders by retry number and creation time', () => {
    const repo = new PrReviewRepository(db);
    repo.upsertComment(
      createPrReviewComment({
        runId,
        prNumber: 7,
        commentId: 100,
        path: 'a.ts',
        line: 1,
        reviewer: 'r',
        body: 'fix',
        now: new Date(),
      }),
    );
    repo.appendCommentAttempt({
      attemptId: 'a1',
      runId,
      commentId: 100,
      retryNumber: 2,
      startHead: 'abc',
      reviewMode: 'post-fix',
      promptPath: '/p.md',
      resultArtifactPath: '/r.md',
      action: 'review',
      createdAt: new Date('2026-07-12T00:02:00Z'),
    });
    repo.appendCommentAttempt({
      attemptId: 'a2',
      runId,
      commentId: 100,
      retryNumber: 0,
      startHead: 'def',
      reviewMode: 'post-fix',
      promptPath: '/p2.md',
      resultArtifactPath: '/r2.md',
      action: 'review',
      createdAt: new Date('2026-07-12T00:01:00Z'),
    });
    repo.appendCommentAttempt({
      attemptId: 'a3',
      runId,
      commentId: 100,
      retryNumber: 1,
      startHead: 'ghi',
      reviewMode: 'post-fix',
      promptPath: '/p3.md',
      resultArtifactPath: '/r3.md',
      action: 'review',
      createdAt: new Date('2026-07-12T00:03:00Z'),
    });
    const listed = repo.listCommentAttempts(runId, 100);
    expect(listed).toHaveLength(3);
    expect(listed[0].attemptId).toBe('a2');
    expect(listed[1].attemptId).toBe('a3');
    expect(listed[2].attemptId).toBe('a1');
  });
});
