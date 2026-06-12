import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { RunId, createPrReviewComment, markReplied } from '@ai-sdlc/domain';
import { registerPrReviewRoutes } from '../routes/pr-review.js';
import { FakePrReviewRepository } from '@ai-sdlc/application/test-doubles';

const runUuid = '66666666-6666-6666-6666-666666666666';

function buildApp(repo: FakePrReviewRepository) {
  const app = Fastify();
  registerPrReviewRoutes(app, { prReviewRepository: repo } as never);
  return app;
}

describe('GET /api/runs/:uuid/pr-review', () => {
  let repo: FakePrReviewRepository;
  beforeEach(() => {
    repo = new FakePrReviewRepository();
  });

  it('returns 400 on bad uuid', async () => {
    const app = buildApp(repo);
    const res = await app.inject({ method: 'GET', url: '/api/runs/not-a-uuid/pr-review' });
    expect(res.statusCode).toBe(400);
  });

  it('returns empty arrays for a run with no PR review data', async () => {
    const app = buildApp(repo);
    const res = await app.inject({ method: 'GET', url: `/api/runs/${runUuid}/pr-review` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.comments).toEqual([]);
    expect(body.pollAttempts).toEqual([]);
  });

  it('returns serialised comments with reply bodies and poll attempts', async () => {
    const runId = RunId(runUuid);
    const c = createPrReviewComment({
      runId,
      prNumber: 5,
      commentId: 9001,
      path: 'src/a.ts',
      line: 3,
      reviewer: 'octocat',
      body: 'please fix this',
      now: new Date('2026-06-04T00:00:00Z'),
    });
    repo.upsertComment(
      markReplied(c, { replyId: 1, outcome: 'fixed', commitSha: 'abc123', poll: 1 }),
    );
    repo.insertReply({
      id: 'r1',
      runId,
      prNumber: 5,
      commentId: 9001,
      body: 'done, thanks',
      postedAt: new Date('2026-06-04T00:01:00Z'),
      verified: true,
    });
    repo.insertPollAttempt({
      id: 'p1',
      runId,
      prNumber: 5,
      pollNumber: 1,
      status: 'completed',
      commentsFetched: 1,
      commentsProcessed: 1,
      startedAt: new Date('2026-06-04T00:00:00Z'),
      completedAt: new Date('2026-06-04T00:05:00Z'),
      terminalState: 'all_resolved',
    });

    const app = buildApp(repo);
    const res = await app.inject({ method: 'GET', url: `/api/runs/${runUuid}/pr-review` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.comments).toHaveLength(1);
    expect(body.comments[0]).toMatchObject({
      commentId: 9001,
      state: 'replied',
      reviewer: 'octocat',
      outcome: 'fixed',
      commitSha: 'abc123',
      replyBody: 'done, thanks',
    });

    expect(body.pollAttempts).toHaveLength(1);
    expect(body.pollAttempts[0]).toMatchObject({
      pollNumber: 1,
      status: 'completed',
      terminalState: 'all_resolved',
    });
  });

  it('serializes terminalState: timed_out', async () => {
    const runId = RunId(runUuid);
    repo.insertPollAttempt({
      id: 'p2',
      runId,
      prNumber: 5,
      pollNumber: 1,
      status: 'completed',
      commentsFetched: 1,
      commentsProcessed: 1,
      startedAt: new Date('2026-06-04T00:00:00Z'),
      completedAt: new Date('2026-06-04T00:05:00Z'),
      terminalState: 'timed_out',
    });

    const app = buildApp(repo);
    const res = await app.inject({ method: 'GET', url: `/api/runs/${runUuid}/pr-review` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.pollAttempts).toHaveLength(1);
    expect(body.pollAttempts[0]).toMatchObject({
      pollNumber: 1,
      status: 'completed',
      terminalState: 'timed_out',
    });
  });
});
