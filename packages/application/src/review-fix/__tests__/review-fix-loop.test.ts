import { describe, it, expect } from 'vitest';
import { RunId, PhaseName, AgentProfileName } from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { FakeLoopRepository } from '../../test-doubles/fake-loop-repository.js';
import { ReviewFixLoop } from '../review-fix-loop.js';
import type {
  ReviewFixLoopDeps,
  ReviewStepResult,
  FixStepResult,
  RevalidationResult,
  FixStepOptions,
  StepContext,
} from '../types.js';

function collectEvents() {
  const events: Array<{ type: string; metadata: Record<string, unknown> }> = [];
  const bus = {
    publish: (_runUuid: string, e: OrchestratorEvent) =>
      events.push({ type: e.type, metadata: e.metadata }),
    subscribe: () => () => {},
  };
  return { events, bus };
}

function baseInput() {
  return {
    runId: RunId('run-1'),
    phaseId: PhaseName('whole-pr-review'),
    repoId: 'owner/repo',
    cwd: '/wt',
    maxIterations: 3,
    reviewProfile: AgentProfileName('opencode-frontier'),
    fixProfile: AgentProfileName('pi-qwen-local'),
    fixFallbackProfile: AgentProfileName('opencode-frontier'),
  };
}

function makeDeps(over: Partial<ReviewFixLoopDeps>): ReviewFixLoopDeps {
  let n = 0;
  const { bus } = collectEvents();
  return {
    runReview: async (): Promise<ReviewStepResult> => ({
      invocationId: `rev-${++n}`,
      agentOutcome: 'success',
      verdict: 'pass',
    }),
    runFix: async (): Promise<FixStepResult> => ({
      invocationId: `fix-${++n}`,
      agentOutcome: 'success',
      verdict: 'done_with_fixes',
    }),
    runRevalidation: async (): Promise<RevalidationResult> => ({
      validationRunId: `val-${++n}`,
      passed: true,
    }),
    loops: new FakeLoopRepository(),
    events: bus,
    now: () => new Date('2026-06-14T00:00:00.000Z'),
    idFactory: () => 'loop-1',
    ...over,
  };
}

describe('ReviewFixLoop', () => {
  it('converges on iteration 1 when review passes immediately', async () => {
    const deps = makeDeps({});
    const out = await new ReviewFixLoop(deps).execute(baseInput());
    expect(out.phaseOutcome).toBe('passed');
    expect(out.loop.status).toBe('converged');
    expect(out.loop.iterations).toHaveLength(1);
    expect(out.loop.iterations[0]?.outcome).toBe('resolved');
  });

  it('converges on iteration 2 (fail -> fix -> pass)', async () => {
    let reviewCalls = 0;
    const deps = makeDeps({
      runReview: async () => {
        reviewCalls += 1;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: reviewCalls === 1 ? ('fail' as const) : ('pass' as const),
        };
      },
    });
    const out = await new ReviewFixLoop(deps).execute(baseInput());
    expect(out.phaseOutcome).toBe('passed');
    expect(out.loop.iterations).toHaveLength(2);
    expect(out.loop.iterations[0]?.outcome).toBe('fixed');
    expect(out.loop.iterations[1]?.outcome).toBe('resolved');
    expect(reviewCalls).toBe(2);
  });

  it('exhausts and fails when review never passes', async () => {
    const { events, bus } = collectEvents();
    const deps = makeDeps({
      events: bus,
      runReview: async () => ({ invocationId: 'r', agentOutcome: 'success', verdict: 'fail' }),
    });
    const out = await new ReviewFixLoop(deps).execute(baseInput());
    expect(out.phaseOutcome).toBe('failed');
    expect(out.loop.status).toBe('exhausted');
    expect(out.loop.iterations).toHaveLength(3);
    expect(events.filter((e) => e.type === 'loop.exhausted')).toHaveLength(1);
  });

  it('hard-fails when the review agent itself fails', async () => {
    const deps = makeDeps({
      runReview: async () => ({ invocationId: 'r', agentOutcome: 'failed' as const }),
    });
    const out = await new ReviewFixLoop(deps).execute(baseInput());
    expect(out.phaseOutcome).toBe('failed');
    expect(out.loop.status).toBe('failed');
    expect(out.loop.iterations[0]?.outcome).toBe('failed');
  });

  it('escalates to the fallback profile after two consecutive fix failures', async () => {
    const { events, bus } = collectEvents();
    const fixCalls: FixStepOptions[] = [];
    const deps = makeDeps({
      events: bus,
      runReview: async () => ({
        invocationId: 'r',
        agentOutcome: 'success' as const,
        verdict: 'fail' as const,
      }),
      runFix: async (_ctx: StepContext, opts: FixStepOptions) => {
        fixCalls.push(opts);
        return { invocationId: `fix-${fixCalls.length}`, agentOutcome: 'failed' as const };
      },
    });
    await new ReviewFixLoop(deps).execute({ ...baseInput(), maxIterations: 3 });

    expect(fixCalls[0]?.useFallback).toBe(false);
    expect(fixCalls[1]?.useFallback).toBe(false);
    expect(fixCalls[2]?.useFallback).toBe(true);
    expect(fixCalls[2]?.previousInvocationId).toBe('fix-2');
    const esc = events.filter((e) => e.type === 'phase.fallback.escalated');
    expect(esc).toHaveLength(1);
    expect(esc[0]?.metadata.triggerOwner).toBe('use_case');
    expect(esc[0]?.metadata.triggerReason).toBe('two_consecutive_fix_failures');
  });

  it('escalates when the revalidation failure category changes between iterations', async () => {
    const { events, bus } = collectEvents();
    const cats = ['build', 'test'];
    let revalCall = 0;
    const fixCalls: FixStepOptions[] = [];
    const deps = makeDeps({
      events: bus,
      runReview: async () => ({ invocationId: 'r', agentOutcome: 'success', verdict: 'fail' }),
      runFix: async (_c: StepContext, opts: FixStepOptions) => {
        fixCalls.push(opts);
        return {
          invocationId: `fix-${fixCalls.length}`,
          agentOutcome: 'success',
          verdict: 'done_with_fixes',
        };
      },
      runRevalidation: async () => ({
        validationRunId: `v${revalCall}`,
        passed: false,
        category: cats[revalCall++] ?? 'test',
      }),
    });
    await new ReviewFixLoop(deps).execute({ ...baseInput(), maxIterations: 3 });
    expect(fixCalls[0]?.useFallback).toBe(false);
    expect(fixCalls[1]?.useFallback).toBe(false);
    expect(fixCalls[2]?.useFallback).toBe(true);
    expect(
      events.some(
        (e) =>
          e.type === 'phase.fallback.escalated' &&
          e.metadata.triggerReason === 'validation_category_changed',
      ),
    ).toBe(true);
  });

  it('emits iteration started/completed events per iteration', async () => {
    const { events, bus } = collectEvents();
    const deps = makeDeps({ events: bus });
    await new ReviewFixLoop(deps).execute(baseInput());
    expect(events.filter((e) => e.type === 'loop.iteration.started')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'loop.iteration.completed')).toHaveLength(1);
  });

  it('does not resolve on review pass when previous revalidation failed (re-runs revalidation instead)', async () => {
    let reviewCalls = 0;
    let revalCalls = 0;
    const deps = makeDeps({
      runReview: async () => {
        reviewCalls += 1;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: reviewCalls === 1 ? ('fail' as const) : ('pass' as const),
        };
      },
      runRevalidation: async () => {
        revalCalls += 1;
        return {
          validationRunId: `val-${revalCalls}`,
          passed: false,
          category: 'build',
        };
      },
    });
    const out = await new ReviewFixLoop(deps).execute(baseInput());
    // Iteration 1: review fail → fix → reval fail → unresolved, outstandingFailedReval = true
    // Iteration 2: review pass → reval fails again (outstanding) → continue → unresolved
    // Iteration 3: review pass → reval fails again → exhausted
    expect(out.phaseOutcome).toBe('failed');
    expect(out.loop.status).toBe('exhausted');
    expect(out.loop.iterations).toHaveLength(3);
    expect(revalCalls).toBe(3);
  });

  it('calls rollbackFix when revalidation fails after a fix with headBeforeFix', async () => {
    const rollbackCalls: Array<{ targetSha: string }> = [];
    const deps = makeDeps({
      runReview: async () => ({ invocationId: 'r', agentOutcome: 'success', verdict: 'fail' }),
      runFix: async () => ({
        invocationId: 'f',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
        headBeforeFix: 'abc123def',
      }),
      runRevalidation: async () => ({
        validationRunId: 'v',
        passed: false,
        category: 'build',
      }),
      rollbackFix: async (_ctx: StepContext, targetSha: string) => {
        rollbackCalls.push({ targetSha });
      },
    });
    const out = await new ReviewFixLoop(deps).execute(baseInput());
    // rollbackFix is called on every iteration where revalidation fails
    // (3 iterations with maxIterations=3)
    expect(rollbackCalls).toHaveLength(3);
    expect(rollbackCalls[0]?.targetSha).toBe('abc123def');
    expect(out.phaseOutcome).toBe('failed');
    expect(out.loop.status).toBe('exhausted');
  });

  it('does not call rollbackFix when revalidation fails but no headBeforeFix', async () => {
    const rollbackCalls: Array<unknown> = [];
    const deps = makeDeps({
      runReview: async () => ({ invocationId: 'r', agentOutcome: 'success', verdict: 'fail' }),
      runFix: async () => ({
        invocationId: 'f',
        agentOutcome: 'success',
        verdict: 'done_no_fixes_needed',
      }),
      runRevalidation: async () => ({
        validationRunId: 'v',
        passed: false,
        category: 'build',
      }),
      rollbackFix: async () => {
        rollbackCalls.push('called');
      },
    });
    await new ReviewFixLoop(deps).execute(baseInput());
    expect(rollbackCalls).toHaveLength(0);
  });

  it('does not call rollbackFix when revalidation passes even with headBeforeFix', async () => {
    const rollbackCalls: Array<unknown> = [];
    const deps = makeDeps({
      runReview: async () => ({ invocationId: 'r', agentOutcome: 'success', verdict: 'fail' }),
      runFix: async () => ({
        invocationId: 'f',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
        headBeforeFix: 'abc123def',
      }),
      rollbackFix: async () => {
        rollbackCalls.push('called');
      },
    });
    await new ReviewFixLoop(deps).execute(baseInput());
    expect(rollbackCalls).toHaveLength(0);
  });

  it('resolves when revalidation retry passes after review pass with outstanding failure', async () => {
    let revalCalls = 0;
    let reviewCalls = 0;
    const deps = makeDeps({
      runReview: async () => {
        reviewCalls += 1;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: reviewCalls === 1 ? ('fail' as const) : ('pass' as const),
        };
      },
      runRevalidation: async () => {
        revalCalls += 1;
        return {
          validationRunId: `val-${revalCalls}`,
          passed: revalCalls > 1,
          category: 'build',
        };
      },
    });
    const out = await new ReviewFixLoop(deps).execute(baseInput());
    // Iteration 1: review fail → fix → reval fail (call 1) → unresolved, outstandingFailedReval = true
    // Iteration 2: review pass → reval retry (call 2) → passes → resolved
    expect(out.phaseOutcome).toBe('passed');
    expect(out.loop.status).toBe('converged');
    expect(out.loop.iterations).toHaveLength(2);
    expect(revalCalls).toBe(2);
  });

  it('proceeds to fix step when phaseId is fix-review and review returns fail', async () => {
    let reviewCalls = 0;
    let fixCalls = 0;
    const deps = makeDeps({
      runReview: async () => {
        reviewCalls += 1;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: reviewCalls === 1 ? ('fail' as const) : ('pass' as const),
        };
      },
      runFix: async () => {
        fixCalls += 1;
        return {
          invocationId: `fix-${fixCalls}`,
          agentOutcome: 'success' as const,
          verdict: 'done_with_fixes' as const,
        };
      },
    });
    const out = await new ReviewFixLoop(deps).execute({
      ...baseInput(),
      phaseId: PhaseName('fix-review'),
    });
    // The review step returns fail (a whole-pr-review-shaped verdict).
    // Despite phaseId being fix-review, the loop must proceed to the fix step.
    // Before the fix, extractResult validated fail against fixReviewResultSchema
    // which only accepts done_with_fixes/done_no_fixes_needed/cannot_fix,
    // causing verdict to be undefined and the loop to hard-fail at iteration 1.
    expect(out.phaseOutcome).toBe('passed');
    expect(out.loop.status).toBe('converged');
    expect(out.loop.iterations).toHaveLength(2);
    expect(out.loop.iterations[0]?.outcome).toBe('fixed');
    expect(out.loop.iterations[1]?.outcome).toBe('resolved');
    expect(reviewCalls).toBe(2);
    expect(fixCalls).toBe(1);
  });

  it('does not converge when review returns overridden pass (severity gate forces fail)', async () => {
    let reviewCalls = 0;
    const deps = makeDeps({
      runReview: async () => {
        reviewCalls += 1;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: reviewCalls === 1 ? ('fail' as const) : ('pass' as const),
          ...(reviewCalls === 1
            ? {
                overridden: true,
                offendingFindings: [{ severity: 'high', summary: 'unused export' }],
              }
            : {}),
        };
      },
    });
    const out = await new ReviewFixLoop(deps).execute(baseInput());
    // Iteration 1: review verdict=overridden "fail" → fix → reval pass → fixed
    // Iteration 2: review verdict=pass (no override) → resolved
    expect(out.phaseOutcome).toBe('passed');
    expect(out.loop.status).toBe('converged');
    expect(out.loop.iterations).toHaveLength(2);
    expect(out.loop.iterations[0]?.outcome).toBe('fixed');
    expect(out.loop.iterations[1]?.outcome).toBe('resolved');
    expect(reviewCalls).toBe(2);
  });
});
