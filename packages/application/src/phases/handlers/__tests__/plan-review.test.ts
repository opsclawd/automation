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

  it('fails with missing_artifact if plan.md is missing before loop execution', async () => {
    const ctx = makeCtx();
    // Intentionally omit writing plan.md
    const loop = fakeLoop({
      loop: {} as never,
      outcome: 'success',
      proceedWithConcerns: false,
    });
    const handler = new PlanReviewHandler({ loop, enabled: true, maxIterations: 3 });
    const out = await handler.run(ctx);
    expect(out.outcome).toBe('failed');
    if (out.outcome === 'failed') {
      expect(out.failure.kind).toBe('missing_artifact');
      expect(out.failure.message).toContain('plan.md not found');
    }
  });

  it('fails with unknown if loop.execute throws', async () => {
    const ctx = makeCtx();
    await ctx.artifacts.write({ runId: ctx.runUuid, relativePath: 'plan.md', contents: '# plan' });
    const loop = {
      execute: vi.fn(async () => {
        throw new Error('loop crashed');
      }),
    } as unknown as PlanReviewLoop;

    const handler = new PlanReviewHandler({ loop, enabled: true, maxIterations: 3 });
    const out = await handler.run(ctx);
    expect(out.outcome).toBe('failed');
    if (out.outcome === 'failed') {
      expect(out.failure.kind).toBe('unknown');
      expect(out.failure.message).toContain('loop crashed');
    }
  });

  it('returns passed on success without concerns (pure happy path)', async () => {
    const ctx = makeCtx();
    await ctx.artifacts.write({ runId: ctx.runUuid, relativePath: 'plan.md', contents: '# plan' });
    const loop = fakeLoop({
      loop: {} as never,
      outcome: 'success',
      proceedWithConcerns: false,
    });
    const handler = new PlanReviewHandler({ loop, enabled: true, maxIterations: 3 });
    const out = await handler.run(ctx);
    expect(out.outcome).toBe('passed');

    // Validate that plan.md hasn't had limitations appended
    const updated = await ctx.artifacts.read(ctx.runUuid, 'plan.md');
    expect(updated).not.toContain('Known Limitations');
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

  it('appends to existing ## Known Limitations section in plan.md', async () => {
    const ctx = makeCtx();
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents: '# plan body\n\n## Known Limitations\n\n- earlier limitation',
    });
    const loop = fakeLoop({
      loop: {} as never,
      outcome: 'success',
      proceedWithConcerns: true,
      knownLimitations: '- new limitation',
    });
    const handler = new PlanReviewHandler({ loop, enabled: true, maxIterations: 3 });
    const out = await handler.run(ctx);
    expect(out.outcome).toBe('passed');
    const updated = await ctx.artifacts.read(ctx.runUuid, 'plan.md');
    expect(updated).toContain('## Known Limitations');
    expect(updated).toContain('- earlier limitation');
    expect(updated).toContain('- new limitation');
  });
});
