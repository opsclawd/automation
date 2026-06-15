import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { RunId, PhaseName, createLoop, startIteration, completeIteration } from '@ai-sdlc/domain';
import { registerReviewFixRoutes } from '../routes/review-fix.js';
import { FakeLoopRepository } from '@ai-sdlc/application/test-doubles';

const runUuid = '44444444-4444-4444-4444-444444444444';

function buildApp(repo: FakeLoopRepository) {
  const app = Fastify();
  registerReviewFixRoutes(app, { loopRepository: repo } as never);
  return app;
}

describe('GET /api/runs/:uuid/review-fix', () => {
  let repo: FakeLoopRepository;
  beforeEach(() => {
    repo = new FakeLoopRepository();
  });

  it('returns 400 on bad uuid', async () => {
    const app = buildApp(repo);
    const res = await app.inject({ method: 'GET', url: '/api/runs/not-a-uuid/review-fix' });
    expect(res.statusCode).toBe(400);
  });

  it('returns { loops: [] } for a run with no loops', async () => {
    const app = buildApp(repo);
    const res = await app.inject({ method: 'GET', url: `/api/runs/${runUuid}/review-fix` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ loops: [] });
  });

  it('returns serialised loops with iterations and artifact paths', async () => {
    const runId = RunId(runUuid);
    let loop = createLoop({
      id: 'loop-1',
      runId,
      phaseId: PhaseName('whole-pr-review'),
      type: 'review-fix',
      maxIterations: 3,
      now: new Date('2026-06-14T00:00:00.000Z'),
    });
    loop = completeIteration(
      startIteration(loop, { reviewInvocationId: 'r1', now: new Date('2026-06-14T00:01:00.000Z') }),
      {
        outcome: 'resolved' as const,
        fixInvocationId: 'f1',
        revalidationId: 're1',
        now: new Date('2026-06-14T00:05:00.000Z'),
      },
    );
    repo.insert(loop);

    const app = buildApp(repo);
    const res = await app.inject({ method: 'GET', url: `/api/runs/${runUuid}/review-fix` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      loops: Array<{
        id: string;
        phaseId: string;
        type: string;
        status: string;
        maxIterations: number;
        startedAt: string;
        completedAt: string | null;
        iterations: Array<{
          index: number;
          outcome: string | null;
          reviewInvocationId: string;
          fixInvocationId: string | null;
          revalidationId: string | null;
          reviewArtifactPath: string;
          fixArtifactPath: string | null;
          revalidateArtifactPath: string | null;
          startedAt: string;
          completedAt: string | null;
        }>;
      }>;
    };

    expect(body.loops).toHaveLength(1);
    expect(body.loops[0]).toMatchObject({
      id: 'loop-1',
      status: 'converged',
      maxIterations: 3,
      startedAt: '2026-06-14T00:00:00.000Z',
      completedAt: '2026-06-14T00:05:00.000Z',
    });

    expect(body.loops[0].iterations).toHaveLength(1);
    expect(body.loops[0].iterations[0]).toMatchObject({
      index: 1,
      outcome: 'resolved',
      reviewInvocationId: 'r1',
      fixInvocationId: 'f1',
      revalidationId: 're1',
      reviewArtifactPath: 'review-fix/review/iter-1/code-review.md',
      fixArtifactPath: 'review-fix/fix/iter-1/result.json',
      revalidateArtifactPath: 'revalidate/iter-1/validation-result.json',
      startedAt: '2026-06-14T00:01:00.000Z',
      completedAt: '2026-06-14T00:05:00.000Z',
    });
  });

  it('returns open iterations (outcome=null) and null completedAt', async () => {
    const runId = RunId(runUuid);
    let loop = createLoop({
      id: 'loop-2',
      runId,
      phaseId: PhaseName('whole-pr-review'),
      type: 'review-fix',
      maxIterations: 2,
      now: new Date('2026-06-14T00:00:00.000Z'),
    });
    loop = startIteration(loop, {
      reviewInvocationId: 'r-open',
      now: new Date('2026-06-14T00:01:00.000Z'),
    });
    repo.insert(loop);

    const app = buildApp(repo);
    const res = await app.inject({ method: 'GET', url: `/api/runs/${runUuid}/review-fix` });
    const body = res.json() as {
      loops: Array<{
        iterations: Array<{
          outcome: string | null;
          completedAt: string | null;
          fixInvocationId: string | null;
          revalidationId: string | null;
          fixArtifactPath: string | null;
          revalidateArtifactPath: string | null;
        }>;
      }>;
    };

    expect(body.loops[0].iterations[0]).toMatchObject({
      outcome: null,
      completedAt: null,
      fixInvocationId: null,
      revalidationId: null,
      fixArtifactPath: null,
      revalidateArtifactPath: null,
    });
  });
});
