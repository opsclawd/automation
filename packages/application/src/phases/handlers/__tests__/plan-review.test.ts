import { describe, it, expect, vi } from 'vitest';
import { PhaseName } from '@ai-sdlc/domain';
import { FakeArtifactStore } from '../../../test-doubles/fake-artifact-store.js';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import type { PhaseHandlerContext } from '../../handler.js';
import type { PlanReviewLoop } from '../../../plan-review/plan-review-loop.js';
import type { PlanReviewLoopResult } from '../../../plan-review/types.js';
import { PlanReviewHandler } from '../plan-review.js';

function makeCtx(): PhaseHandlerContext & { _events: OrchestratorEvent[] } {
  const events: OrchestratorEvent[] = [];
  return {
    runId: 'run-1',
    runUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    repoFullName: 'owner/repo',
    issueNumber: 42,
    cwd: '/wt',
    artifacts: new FakeArtifactStore(),
    github: {} as never,
    git: {} as never,
    agent: {} as never,
    events: {
      publish: (_u: string, e: OrchestratorEvent) => events.push(e),
      subscribe: () => () => {},
    },
    now: () => new Date('2026-07-08T00:00:00Z'),
  } as PhaseHandlerContext & { _events: OrchestratorEvent[] };
}

function fakeLoop(result: PlanReviewLoopResult) {
  return {
    execute: vi.fn(async () => result),
  } as unknown as PlanReviewLoop & { execute: ReturnType<typeof vi.fn> };
}

describe('PlanReviewHandler', () => {
  it('returns passed immediately when enabled is false (AC #4)', async () => {
    const ctx = makeCtx();
    const loop = fakeLoop({
      loop: {
        id: 'unused',
        runId: 'run-1' as never,
        phaseId: PhaseName('plan-review'),
        type: 'plan-review',
        maxIterations: 1,
        iterations: [],
        status: 'running',
        startedAt: new Date(),
      },
      outcome: 'success',
      proceedWithConcerns: false,
    });
    const handler = new PlanReviewHandler({ loop, enabled: false, maxIterations: 3 });
    const out = await handler.run(ctx);
    expect(out.outcome).toBe('passed');
    expect(loop.execute).not.toHaveBeenCalled();
  });

  it('maps loop failed → failed with agent_incomplete', async () => {
    const ctx = makeCtx();
    await ctx.artifacts.write({ runId: ctx.runUuid, relativePath: 'plan.md', contents: '# plan' });
    const loop = fakeLoop({
      loop: {
        id: 'l1',
        runId: ctx.runUuid as never,
        phaseId: PhaseName('plan-review'),
        type: 'plan-review',
        maxIterations: 1,
        iterations: [],
        status: 'failed',
        startedAt: new Date(),
        completedAt: new Date(),
      },
      outcome: 'failed',
      proceedWithConcerns: false,
    });
    const handler = new PlanReviewHandler({ loop, enabled: true, maxIterations: 3 });
    const out = await handler.run(ctx);
    expect(out.outcome).toBe('failed');
    if (out.outcome === 'failed') {
      expect(out.failure.kind).toBe('agent_incomplete');
    }
  });

  it('maps loop needs_human_review → needs_human_review with canRetry: true', async () => {
    const ctx = makeCtx();
    await ctx.artifacts.write({ runId: ctx.runUuid, relativePath: 'plan.md', contents: '# plan' });
    const loop = fakeLoop({
      loop: {
        id: 'l2',
        runId: ctx.runUuid as never,
        phaseId: PhaseName('plan-review'),
        type: 'plan-review',
        maxIterations: 1,
        iterations: [],
        status: 'exhausted',
        startedAt: new Date(),
        completedAt: new Date(),
      },
      outcome: 'needs_human_review',
      proceedWithConcerns: false,
    });
    const handler = new PlanReviewHandler({ loop, enabled: true, maxIterations: 1 });
    const out = await handler.run(ctx);
    expect(out.outcome).toBe('needs_human_review');
    if (out.outcome === 'needs_human_review') {
      expect(out.failure.kind).toBe('agent_incomplete');
      expect(out.failure.canRetry).toBe(true);
    }
  });

  it('appends ## Known Limitations to plan.md on proceed_with_concerns (AC #3)', async () => {
    const ctx = makeCtx();
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents: '# plan body',
    });
    const loop = fakeLoop({
      loop: {
        id: 'l3',
        runId: ctx.runUuid as never,
        phaseId: PhaseName('plan-review'),
        type: 'plan-review',
        maxIterations: 1,
        iterations: [],
        status: 'converged',
        startedAt: new Date(),
        completedAt: new Date(),
      },
      outcome: 'success',
      proceedWithConcerns: true,
      knownLimitations: '- cannot test legacy bash parity',
    });
    const handler = new PlanReviewHandler({ loop, enabled: true, maxIterations: 3 });
    const out = await handler.run(ctx);
    expect(out.outcome).toBe('passed');
    const updated = await ctx.artifacts.read(ctx.runUuid, 'plan.md');
    expect(updated).toContain('## Known Limitations');
    expect(updated).toContain('cannot test legacy bash parity');
  });
});
