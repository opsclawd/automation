import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RunId, createPrReviewComment, markReplied, type PollAttempt } from '@ai-sdlc/domain';
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
});
