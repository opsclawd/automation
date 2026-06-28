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
  PostFixGateResult,
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
    runPostFixGate: async (): Promise<PostFixGateResult> => ({
      outcome: 'pass',
      output: '',
    }),
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

  it('records review outcome before invoking cleanArtifacts hook on review agent failure', async () => {
    const orderLog: string[] = [];
    const deps = makeDeps({
      runReview: async () => {
        orderLog.push('runReview');
        return { invocationId: 'r-fail', agentOutcome: 'failed' as const };
      },
      cleanArtifacts: async () => {
        orderLog.push('cleanArtifacts');
      },
    });
    const originalUpdate = deps.loops.update.bind(deps.loops);
    deps.loops.update = (loop) => {
      const outcome = loop.iterations[0]?.outcome;
      orderLog.push(`loops.update:${outcome ?? 'none'}:${loop.status}`);
      originalUpdate(loop);
    };

    await new ReviewFixLoop(deps).execute(baseInput());

    expect(orderLog).toEqual([
      'runReview',
      'loops.update:none:running',
      'loops.update:failed:failed',
      'cleanArtifacts',
    ]);
  });

  it('records unresolved outcome before invoking cleanArtifacts hook on fix failure', async () => {
    const orderLog: string[] = [];
    const deps = makeDeps({
      runReview: async () => {
        orderLog.push('runReview');
        return {
          invocationId: 'r-success',
          agentOutcome: 'success' as const,
          verdict: 'fail' as const,
        };
      },
      runFix: async () => {
        orderLog.push('runFix');
        return { invocationId: 'f-fail', agentOutcome: 'failed' as const };
      },
      cleanArtifacts: async () => {
        orderLog.push('cleanArtifacts');
      },
    });
    const originalUpdate = deps.loops.update.bind(deps.loops);
    deps.loops.update = (loop) => {
      const outcome = loop.iterations[0]?.outcome;
      orderLog.push(`loops.update:${outcome ?? 'none'}:${loop.status}`);
      originalUpdate(loop);
    };

    // Use maxIterations: 1 so the loop completes after the first iteration
    await new ReviewFixLoop(deps).execute({ ...baseInput(), maxIterations: 1 });

    expect(orderLog).toEqual([
      'runReview',
      'loops.update:none:running',
      'runFix',
      'loops.update:unresolved:running',
      'cleanArtifacts',
      'loops.update:unresolved:exhausted',
    ]);
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
        return true;
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
        return true;
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
        return true;
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

  it('emits review.verdict.overridden event when verdict is overridden', async () => {
    const { events, bus } = collectEvents();
    let reviewCalls = 0;
    const deps = makeDeps({
      events: bus,
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
    await new ReviewFixLoop(deps).execute(baseInput());
    const overrideEvents = events.filter((e) => e.type === 'review.verdict.overridden');
    expect(overrideEvents).toHaveLength(1);
    expect(overrideEvents[0]?.metadata.offendingFindings).toEqual([
      { severity: 'high', summary: 'unused export' },
    ]);
    expect(overrideEvents[0]?.metadata.threshold).toBe('high');
    expect(overrideEvents[0]?.metadata.direction).toBe('upgrade');
  });

  it('converges when review returns fail with only sub-threshold findings', async () => {
    let reviewCalls = 0;
    const deps = makeDeps({
      runReview: async () => {
        reviewCalls += 1;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: 'pass' as const,
          overridden: reviewCalls === 1 ? true : undefined,
          offendingFindings: reviewCalls === 1 ? [] : undefined,
        };
      },
    });
    const out = await new ReviewFixLoop(deps).execute(baseInput());
    // Iteration 1: review returns fail but gate overrides to pass → loop converges
    expect(out.phaseOutcome).toBe('passed');
    expect(out.loop.status).toBe('converged');
    expect(out.loop.iterations).toHaveLength(1);
    expect(out.loop.iterations[0]?.outcome).toBe('resolved');
    expect(reviewCalls).toBe(1);
  });

  it('does not converge when review returns fail with empty findings (no override)', async () => {
    const deps = makeDeps({
      runReview: async () => ({
        invocationId: 'r',
        agentOutcome: 'success',
        verdict: 'fail',
        overridden: false,
      }),
    });
    const out = await new ReviewFixLoop(deps).execute(baseInput());
    expect(out.phaseOutcome).toBe('failed');
    expect(out.loop.status).toBe('exhausted');
    expect(out.loop.iterations).toHaveLength(3);
  });

  it('emits review.verdict.overridden with direction downgrade for fail→pass override', async () => {
    const { events, bus } = collectEvents();
    let reviewCalls = 0;
    const deps = makeDeps({
      events: bus,
      runReview: async () => {
        reviewCalls += 1;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: 'pass' as const,
          overridden: reviewCalls === 1 ? true : undefined,
          offendingFindings: [],
        };
      },
    });
    await new ReviewFixLoop(deps).execute(baseInput());
    const overrideEvents = events.filter((e) => e.type === 'review.verdict.overridden');
    expect(overrideEvents).toHaveLength(1);
    expect(overrideEvents[0]?.metadata.direction).toBe('downgrade');
    expect(overrideEvents[0]?.metadata.threshold).toBe('high');
  });

  describe('oscillation detection', () => {
    it('escalates when a finding oscillates across 3 iterations (present → absent → present)', async () => {
      const { events, bus } = collectEvents();
      let reviewCall = 0;
      const findings = [
        [{ severity: 'high', summary: 'type error' }],
        [{ severity: 'high', summary: 'unused import' }],
        [{ severity: 'high', summary: 'type error' }],
      ];
      const fixCalls: FixStepOptions[] = [];
      const deps = makeDeps({
        events: bus,
        runReview: async () => {
          const i = reviewCall++;
          return {
            invocationId: `rev-${i + 1}`,
            agentOutcome: 'success' as const,
            verdict: 'fail' as const,
            offendingFindings: findings[i] ?? [],
          };
        },
        runFix: async (_ctx: StepContext, opts: FixStepOptions) => {
          fixCalls.push(opts);
          return {
            invocationId: `fix-${fixCalls.length}`,
            agentOutcome: 'success' as const,
            verdict: 'done_with_fixes' as const,
          };
        },
      });

      await new ReviewFixLoop(deps).execute({ ...baseInput(), maxIterations: 5 });

      expect(fixCalls[2]?.useFallback).toBe(true);

      const esc = events.filter((e) => e.type === 'phase.fallback.escalated');
      expect(esc.length).toBeGreaterThanOrEqual(1);
      expect(esc.some((e) => e.metadata.triggerReason === 'oscillation_detected')).toBe(true);
    });

    it('escalates when the same finding persists across 3 iterations (no_progress)', async () => {
      const { events, bus } = collectEvents();
      let reviewCall = 0;
      const fixCalls: FixStepOptions[] = [];
      const deps = makeDeps({
        events: bus,
        runReview: async () => {
          reviewCall++;
          return {
            invocationId: `rev-${reviewCall}`,
            agentOutcome: 'success' as const,
            verdict: 'fail' as const,
            offendingFindings: [{ severity: 'high', summary: 'type error' }],
          };
        },
        runFix: async (_ctx: StepContext, opts: FixStepOptions) => {
          fixCalls.push(opts);
          return {
            invocationId: `fix-${fixCalls.length}`,
            agentOutcome: 'success' as const,
            verdict: 'done_with_fixes' as const,
          };
        },
      });

      await new ReviewFixLoop(deps).execute({ ...baseInput(), maxIterations: 5 });

      expect(fixCalls[2]?.useFallback).toBe(true);

      const esc = events.filter((e) => e.type === 'phase.fallback.escalated');
      expect(esc.length).toBeGreaterThanOrEqual(1);
      expect(esc.some((e) => e.metadata.triggerReason === 'no_progress_detected')).toBe(true);
    });

    it('does not escalate for stall when history has fewer than 3 failing iterations', async () => {
      const { events, bus } = collectEvents();
      let reviewCall = 0;
      const deps = makeDeps({
        events: bus,
        runReview: async () => {
          reviewCall++;
          return {
            invocationId: `rev-${reviewCall}`,
            agentOutcome: 'success' as const,
            verdict: reviewCall <= 2 ? ('fail' as const) : ('pass' as const),
            offendingFindings: reviewCall <= 2 ? [{ severity: 'high', summary: 'type error' }] : [],
          };
        },
      });

      const out = await new ReviewFixLoop(deps).execute({ ...baseInput(), maxIterations: 5 });

      expect(out.phaseOutcome).toBe('passed');
      const esc = events.filter(
        (e) =>
          e.type === 'phase.fallback.escalated' &&
          (e.metadata.triggerReason === 'oscillation_detected' ||
            e.metadata.triggerReason === 'no_progress_detected'),
      );
      expect(esc).toHaveLength(0);
    });

    it('does not escalate when fixFallbackProfile is not configured', async () => {
      const { events, bus } = collectEvents();
      let reviewCall = 0;
      const deps = makeDeps({
        events: bus,
        runReview: async () => {
          reviewCall++;
          return {
            invocationId: `rev-${reviewCall}`,
            agentOutcome: 'success' as const,
            verdict: 'fail' as const,
            offendingFindings: [{ severity: 'high', summary: 'type error' }],
          };
        },
      });

      const inputWithoutFallback = { ...baseInput(), fixFallbackProfile: undefined };
      await new ReviewFixLoop(deps).execute({ ...inputWithoutFallback, maxIterations: 4 });

      const esc = events.filter(
        (e) =>
          e.type === 'phase.fallback.escalated' &&
          (e.metadata.triggerReason === 'oscillation_detected' ||
            e.metadata.triggerReason === 'no_progress_detected'),
      );
      expect(esc).toHaveLength(0);
    });

    it('does not emit any escalation event on consecutive fix failures when fixFallbackProfile is undefined', async () => {
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

      const inputWithoutFallback = { ...baseInput(), fixFallbackProfile: undefined };
      await new ReviewFixLoop(deps).execute({ ...inputWithoutFallback, maxIterations: 4 });

      const esc = events.filter((e) => e.type === 'phase.fallback.escalated');
      expect(esc).toHaveLength(0);
    });
  });

  describe('post-fix gate', () => {
    it('does not call runPostFixGate on iteration 1', async () => {
      const gateCalls: number[] = [];
      const deps = makeDeps({
        runPostFixGate: async (ctx) => {
          gateCalls.push(ctx.iterationIndex);
          return { outcome: 'pass' as const, output: '' };
        },
      });
      const out = await new ReviewFixLoop(deps).execute(baseInput());
      // Review passes immediately on iteration 1 — gate must NOT run
      expect(out.phaseOutcome).toBe('passed');
      expect(gateCalls).toHaveLength(0);
    });

    it('does not call runPostFixGate on iteration 2 when previous fix returned cannot_fix', async () => {
      const gateCalls: number[] = [];
      let reviewCalls = 0;
      const deps = makeDeps({
        runPostFixGate: async (ctx) => {
          gateCalls.push(ctx.iterationIndex);
          return { outcome: 'pass' as const, output: '' };
        },
        runReview: async () => {
          reviewCalls += 1;
          return {
            invocationId: `rev-${reviewCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'fail' as const,
          };
        },
        runFix: async () => ({
          invocationId: 'fix-1',
          agentOutcome: 'success' as const,
          verdict: 'cannot_fix' as const,
        }),
      });
      const out = await new ReviewFixLoop(deps).execute({
        ...baseInput(),
        maxIterations: 4,
      });
      // Iteration 1: review fail → fix (cannot_fix) → continue
      // Iteration 2: gate NOT called (no fix commit), review fail → fix (cannot_fix) → continue
      // Iteration 3: gate NOT called (no fix commit), review fail → fix (cannot_fix) → exhaust
      expect(out.phaseOutcome).toBe('failed');
      expect(gateCalls).toHaveLength(0);
    });

    it('calls runPostFixGate on iteration 2 (after a fixer commit)', async () => {
      const gateCalls: number[] = [];
      let reviewCalls = 0;
      const deps = makeDeps({
        runPostFixGate: async (ctx) => {
          gateCalls.push(ctx.iterationIndex);
          return { outcome: 'pass' as const, output: '' };
        },
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
      // Iteration 1: review fail → fix → reval pass
      // Iteration 2: gate runs, review pass → resolved
      expect(out.phaseOutcome).toBe('passed');
      expect(gateCalls).toEqual([2]);
    });

    it('passes gate failure result to runReview on iteration 2', async () => {
      let reviewCalls = 0;
      const receivedGateResults: Array<PostFixGateResult | undefined> = [];
      const deps = makeDeps({
        runPostFixGate: async (): Promise<PostFixGateResult> => ({
          outcome: 'fail',
          output: 'src/foo.ts(1,1): error TS2322: Type string is not assignable to type number',
        }),
        runReview: async (_ctx, gateResult) => {
          reviewCalls += 1;
          receivedGateResults.push(gateResult);
          return {
            invocationId: `rev-${reviewCalls}`,
            agentOutcome: 'success' as const,
            // Simulate reviewer receiving the gate failure and returning fail,
            // then pass on third call (iteration 3, second gate check)
            verdict: reviewCalls < 3 ? ('fail' as const) : ('pass' as const),
          };
        },
      });
      await new ReviewFixLoop(deps).execute({ ...baseInput(), maxIterations: 4 });
      // Iteration 1: gate undefined (not called), reviewer called with undefined
      expect(receivedGateResults[0]).toBeUndefined();
      // Iteration 2: gate called and returns fail, reviewer receives failure
      expect(receivedGateResults[1]).toEqual({
        outcome: 'fail',
        output: 'src/foo.ts(1,1): error TS2322: Type string is not assignable to type number',
      });
    });

    it('passes gate pass result to runReview when gate succeeds on iteration 2', async () => {
      let reviewCalls = 0;
      const receivedGateResults: Array<PostFixGateResult | undefined> = [];
      const deps = makeDeps({
        runPostFixGate: async (): Promise<PostFixGateResult> => ({
          outcome: 'pass',
          output: '',
        }),
        runReview: async (_ctx, gateResult) => {
          reviewCalls += 1;
          receivedGateResults.push(gateResult);
          return {
            invocationId: `rev-${reviewCalls}`,
            agentOutcome: 'success' as const,
            verdict: reviewCalls === 1 ? ('fail' as const) : ('pass' as const),
          };
        },
      });
      const out = await new ReviewFixLoop(deps).execute(baseInput());
      expect(out.phaseOutcome).toBe('passed');
      // Iteration 1: gate not called, runReview receives undefined
      expect(receivedGateResults[0]).toBeUndefined();
      // Iteration 2: gate called (pass), runReview receives pass result
      expect(receivedGateResults[1]).toEqual({ outcome: 'pass', output: '' });
    });
  });
});
