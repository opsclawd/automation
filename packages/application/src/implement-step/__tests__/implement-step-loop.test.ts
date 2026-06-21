import { describe, it, expect, vi } from 'vitest';
import { RunId, PhaseName, AgentProfileName } from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { FakeLoopRepository } from '../../test-doubles/fake-loop-repository.js';
import { ImplementStepLoop } from '../implement-step-loop.js';
import type {
  ImplementStepLoopDeps,
  ImplementResult,
  SpecReviewResult,
  QualityReviewResult,
  FixResult,
  StepLoopContext,
  TypecheckResult,
} from '../types.js';
import type { FixStepOptions } from '../../review-fix/types.js';
import type { EventBusPort } from '../../ports/event-bus-port.js';

function collectEvents() {
  const events: Array<{
    type: string;
    level: string;
    message: string;
    metadata: Record<string, unknown>;
  }> = [];
  const bus: EventBusPort = {
    publish: (_runUuid: string, e: OrchestratorEvent) =>
      events.push({ type: e.type, level: e.level, message: e.message, metadata: e.metadata }),
    subscribe: () => () => {},
  };
  return { events, bus };
}

function baseInput() {
  return {
    runId: RunId('run-1'),
    phaseId: PhaseName('implement'),
    repoId: 'owner/repo',
    cwd: '/wt',
    stepIndex: 1,
    stepTitle: 'Add login page',
    maxIterations: 3,
  };
}

function makeDeps(over: Partial<ImplementStepLoopDeps>): ImplementStepLoopDeps {
  let n = 0;
  const { bus } = collectEvents();
  return {
    runImplement: async (): Promise<ImplementResult> => ({
      invocationId: `impl-${++n}`,
      agentOutcome: 'success',
    }),
    runTypecheck: async (): Promise<TypecheckResult> => ({
      outcome: 'pass',
      output: '',
    }),
    runSpecReview: async (
      _ctx: StepLoopContext,
      _tcResult: TypecheckResult,
    ): Promise<SpecReviewResult> => ({
      invocationId: `sr-${++n}`,
      agentOutcome: 'success',
      verdict: 'pass',
    }),
    runQualityReview: async (
      _ctx: StepLoopContext,
      _tcResult: TypecheckResult,
    ): Promise<QualityReviewResult> => ({
      invocationId: `qr-${++n}`,
      agentOutcome: 'success',
      verdict: 'pass',
    }),
    runFix: async (): Promise<FixResult> => ({
      invocationId: `fix-${++n}`,
      agentOutcome: 'success',
      verdict: 'done_with_fixes',
    }),
    loops: new FakeLoopRepository(),
    events: bus,
    fixProfile: AgentProfileName('pi-qwen-local'),
    fixFallbackProfile: AgentProfileName('opencode-frontier'),
    now: () => new Date('2026-06-17T00:00:00.000Z'),
    idFactory: () => 'loop-1',
    ...over,
  };
}

describe('ImplementStepLoop', () => {
  it('converges on iteration 1 when both reviews pass immediately', async () => {
    const deps = makeDeps({});
    const out = await new ImplementStepLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('success');
    expect(out.loop.status).toBe('converged');
    expect(out.loop.iterations).toHaveLength(1);
    expect(out.loop.iterations[0]?.outcome).toBe('resolved');
    // Loop persisted
    expect(deps.loops.findById(out.loop.id)).toBeDefined();
  });

  it('converges on iteration 2 when spec-review fails on first iteration', async () => {
    let specReviewCalls = 0;
    const deps = makeDeps({
      runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => {
        specReviewCalls += 1;
        return {
          invocationId: `sr-${specReviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: specReviewCalls === 1 ? ('fail' as const) : ('pass' as const),
        };
      },
    });
    const out = await new ImplementStepLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('success');
    expect(out.loop.iterations).toHaveLength(2);
    expect(out.loop.iterations[0]?.outcome).toBe('fixed');
    expect(out.loop.iterations[1]?.outcome).toBe('resolved');
  });

  it('converges on iteration 2 when quality-review fails on first iteration', async () => {
    let qualityReviewCalls = 0;
    const deps = makeDeps({
      runQualityReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => {
        qualityReviewCalls += 1;
        return {
          invocationId: `qr-${qualityReviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: qualityReviewCalls === 1 ? ('fail' as const) : ('pass' as const),
        };
      },
    });
    const out = await new ImplementStepLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('success');
    expect(out.loop.iterations).toHaveLength(2);
    expect(out.loop.iterations[0]?.outcome).toBe('fixed');
    expect(out.loop.iterations[1]?.outcome).toBe('resolved');
  });

  it('converges on iteration 2 when BOTH reviews fail on first iteration', async () => {
    let specReviewCalls = 0;
    let qualityReviewCalls = 0;
    const deps = makeDeps({
      runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => {
        specReviewCalls += 1;
        return {
          invocationId: `sr-${specReviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: specReviewCalls === 1 ? ('fail' as const) : ('pass' as const),
        };
      },
      runQualityReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => {
        qualityReviewCalls += 1;
        return {
          invocationId: `qr-${qualityReviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: qualityReviewCalls === 1 ? ('fail' as const) : ('pass' as const),
        };
      },
    });
    const out = await new ImplementStepLoop(deps).execute(baseInput());
    // Iteration 1: spec-review fail → quality-review fail → fix → fixed
    // Iteration 2: spec-review pass → quality-review pass → resolved
    expect(out.outcome).toBe('success');
    expect(out.loop.iterations).toHaveLength(2);
    expect(out.loop.iterations[0]?.outcome).toBe('fixed');
    expect(out.loop.iterations[1]?.outcome).toBe('resolved');
  });

  it('hard fails when the implement agent fails', async () => {
    const deps = makeDeps({
      runImplement: async () => ({ invocationId: 'impl-1', agentOutcome: 'failed' as const }),
    });
    const out = await new ImplementStepLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('failed');
    expect(out.loop.status).toBe('failed');
    expect(out.loop.iterations).toHaveLength(1);
    expect(out.loop.iterations[0]?.outcome).toBe('failed');
  });

  it('exhausts and fails when reviews never pass within maxIterations', async () => {
    const { events, bus } = collectEvents();
    const deps = makeDeps({
      events: bus,
      runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => ({
        invocationId: 'sr-1',
        agentOutcome: 'success' as const,
        verdict: 'fail' as const,
      }),
      runQualityReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => ({
        invocationId: 'qr-1',
        agentOutcome: 'success' as const,
        verdict: 'pass' as const,
      }),
      runFix: async () => ({
        invocationId: 'fix-1',
        agentOutcome: 'success' as const,
        verdict: 'done_with_fixes' as const,
      }),
      runImplement: async () => ({ invocationId: 'impl-1', agentOutcome: 'success' as const }),
    });
    const out = await new ImplementStepLoop(deps).execute(baseInput());
    // maxIterations=3 → 3 iterations of fail→pass→fix→fail→pass→fix → exhausted
    expect(out.outcome).toBe('failed');
    expect(out.loop.status).toBe('exhausted');
    expect(out.loop.iterations).toHaveLength(3);
    expect(events.filter((e) => e.type === 'loop.exhausted')).toHaveLength(1);
  });

  it('escalates to fallback profile after two consecutive fix failures', async () => {
    const { events, bus } = collectEvents();
    const fixCalls: FixStepOptions[] = [];
    const deps = makeDeps({
      events: bus,
      runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => ({
        invocationId: 'sr-1',
        agentOutcome: 'success' as const,
        verdict: 'fail' as const,
      }),
      runQualityReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => ({
        invocationId: 'qr-1',
        agentOutcome: 'success' as const,
        verdict: 'pass' as const,
      }),
      runFix: async (_ctx: StepLoopContext, opts: FixStepOptions) => {
        fixCalls.push(opts);
        return { invocationId: `fix-${fixCalls.length}`, agentOutcome: 'failed' as const };
      },
    });
    await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 3 });
    expect(fixCalls[0]?.useFallback).toBe(false);
    expect(fixCalls[1]?.useFallback).toBe(false);
    expect(fixCalls[2]?.useFallback).toBe(true);
    expect(fixCalls[2]?.previousInvocationId).toBe('fix-2');
    const esc = events.filter((e) => e.type === 'phase.fallback.escalated');
    expect(esc).toHaveLength(1);
    expect(esc[0]?.metadata.triggerOwner).toBe('use_case');
    expect(esc[0]?.metadata.triggerReason).toBe('two_consecutive_fix_failures');
    expect(esc[0]?.metadata.fromProfile).toBe(deps.fixProfile);
    expect(esc[0]?.metadata.toProfile).toBe(deps.fixFallbackProfile);
  });

  it('escalates on iteration 3 when fix fails on iterations 1 and 2', async () => {
    // Verify the exact boundary: fail on iteration 1 fix, fail on iteration 2 fix, escalate on iteration 3 fix
    let fixCalls = 0;
    const fixCallOptions: FixStepOptions[] = [];
    const { events, bus } = collectEvents();
    const deps = makeDeps({
      events: bus,
      runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => ({
        invocationId: 'sr-1',
        agentOutcome: 'success' as const,
        verdict: 'fail' as const,
      }),
      runFix: async (_ctx: StepLoopContext, opts: FixStepOptions) => {
        fixCalls += 1;
        fixCallOptions.push(opts);
        return {
          invocationId: `fix-${fixCalls}`,
          agentOutcome: 'failed' as const,
        };
      },
    });
    await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 3 });
    expect(fixCalls).toBe(3); // iterations 1, 2, 3 all fail fix
    expect(fixCallOptions[0]?.useFallback).toBe(false);
    expect(fixCallOptions[1]?.useFallback).toBe(false);
    expect(fixCallOptions[2]?.useFallback).toBe(true);
    const esc = events.filter((e) => e.type === 'phase.fallback.escalated');
    expect(esc).toHaveLength(1);
  });

  it('does NOT escalate when a single fix fails then succeeds (consecutive counter resets)', async () => {
    let fixCalls = 0;
    const fixCallOptions: FixStepOptions[] = [];
    const { events, bus } = collectEvents();
    const deps = makeDeps({
      events: bus,
      runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => ({
        invocationId: 'sr-1',
        agentOutcome: 'success' as const,
        verdict: 'fail' as const,
      }),
      runFix: async (_ctx: StepLoopContext, opts: FixStepOptions) => {
        fixCalls += 1;
        fixCallOptions.push(opts);
        return {
          invocationId: `fix-${fixCalls}`,
          agentOutcome: fixCalls === 1 ? ('failed' as const) : ('success' as const),
          verdict: fixCalls === 1 ? undefined : ('done_with_fixes' as const),
        };
      },
    });
    await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 3 });
    // Iteration 1: fix fails → unresolved
    // Iteration 2: fix succeeds → counter resets → fixed
    // Iteration 3: spec-review still fails → fix succeeds (no escalation needed)
    expect(fixCalls).toBe(3);
    expect(fixCallOptions[1]?.useFallback).toBe(false);
    const esc = events.filter((e) => e.type === 'phase.fallback.escalated');
    expect(esc).toHaveLength(0);
  });

  it('hard fails when spec-review agent outcome is not success', async () => {
    const deps = makeDeps({
      runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => ({
        invocationId: 'sr-1',
        agentOutcome: 'timeout' as const,
      }),
    });
    // Note: runImplement succeeds, then first iteration spec-review times out → hard fail
    const out = await new ImplementStepLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('failed');
    expect(out.loop.status).toBe('failed');
    expect(out.loop.iterations).toHaveLength(1);
    expect(out.loop.iterations[0]?.outcome).toBe('failed');
  });

  it('hard fails when spec-review returns undefined verdict (contract violation)', async () => {
    const deps = makeDeps({
      runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => ({
        invocationId: 'sr-1',
        agentOutcome: 'success' as const,
      }),
    });
    const out = await new ImplementStepLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('failed');
    expect(out.loop.status).toBe('failed');
    expect(out.loop.iterations).toHaveLength(1);
    expect(out.loop.iterations[0]?.outcome).toBe('failed');
  });

  it('hard fails when quality-review agent outcome is not success', async () => {
    const deps = makeDeps({
      runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => ({
        invocationId: 'sr-1',
        agentOutcome: 'success' as const,
        verdict: 'pass' as const,
      }),
      runQualityReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => ({
        invocationId: 'qr-1',
        agentOutcome: 'contract_violation' as const,
      }),
    });
    const out = await new ImplementStepLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('failed');
    expect(out.loop.status).toBe('failed');
    expect(out.loop.iterations).toHaveLength(1);
    expect(out.loop.iterations[0]?.outcome).toBe('failed');
  });

  it('emits loop iteration started and completed events', async () => {
    const { events, bus } = collectEvents();
    const deps = makeDeps({ events: bus });
    await new ImplementStepLoop(deps).execute(baseInput());
    expect(events.filter((e) => e.type === 'loop.iteration.started')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'loop.iteration.completed')).toHaveLength(1);
  });

  it('emits loop.exhausted event when loop exhausts', async () => {
    const { events, bus } = collectEvents();
    const deps = makeDeps({
      events: bus,
      runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => ({
        invocationId: 'sr-1',
        agentOutcome: 'success' as const,
        verdict: 'fail' as const,
      }),
    });
    const out = await new ImplementStepLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('failed');
    const exhausted = events.filter((e) => e.type === 'loop.exhausted');
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]?.level).toBe('error');
    expect(exhausted[0]?.message).toBe('implement-step loop exhausted after 3 iterations');
    expect(exhausted[0]?.metadata.iterations).toBe(3);
    expect(exhausted[0]?.metadata.maxIterations).toBe(3);
  });

  it('persists loop via LoopRepositoryPort on each state change', async () => {
    const deps = makeDeps({
      runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => ({
        invocationId: 'sr-1',
        agentOutcome: 'success' as const,
        verdict: 'fail' as const,
      }),
      runFix: async () => ({
        invocationId: 'fix-1',
        agentOutcome: 'success' as const,
        verdict: 'done_with_fixes' as const,
      }),
    });
    await new ImplementStepLoop(deps).execute(baseInput());
    const found = deps.loops.findById('loop-1');
    expect(found).toBeDefined();
    expect(found?.iterations.length).toBe(3); // 3 iterations inserted
    // Exercise update path: second read should match persisted state
    const refetch = deps.loops.findById('loop-1');
    expect(refetch?.status).toBe('exhausted');
    expect(refetch?.iterations).toHaveLength(3);
  });

  it('does not call runImplement beyond the first (pre-loop) execution', async () => {
    let implementCalls = 0;
    let specCalls = 0;
    const deps = makeDeps({
      runImplement: async () => {
        implementCalls += 1;
        return { invocationId: 'impl-1', agentOutcome: 'success' as const };
      },
      runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => {
        specCalls += 1;
        return {
          invocationId: `sr-${specCalls}`,
          agentOutcome: 'success' as const,
          verdict: specCalls === 1 ? ('fail' as const) : ('pass' as const),
        };
      },
      runFix: async () => ({
        invocationId: 'fix-1',
        agentOutcome: 'success' as const,
        verdict: 'done_with_fixes' as const,
      }),
    });
    await new ImplementStepLoop(deps).execute(baseInput());
    // Implement should run exactly once (pre-loop), not per iteration
    expect(implementCalls).toBe(1);
    // spec-review runs on each iteration (2 iterations to converge)
    expect(specCalls).toBe(2);
  });

  it('does not escalate when fixFallbackProfile is undefined (even with two consecutive failures)', async () => {
    const { events, bus } = collectEvents();
    const deps = makeDeps({
      events: bus,
      fixFallbackProfile: undefined,
      runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => ({
        invocationId: 'sr-1',
        agentOutcome: 'success' as const,
        verdict: 'fail' as const,
      }),
      runFix: async () => ({
        invocationId: 'fix-1',
        agentOutcome: 'failed' as const,
      }),
    });
    const out = await new ImplementStepLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('failed');
    const esc = events.filter((e) => e.type === 'phase.fallback.escalated');
    expect(esc).toHaveLength(0);
  });

  it('does NOT converge when only spec-review passes (quality-review fails)', async () => {
    const deps = makeDeps({
      runQualityReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => ({
        invocationId: 'qr-1',
        agentOutcome: 'success' as const,
        verdict: 'fail' as const,
      }),
      runFix: async () => ({
        invocationId: 'fix-1',
        agentOutcome: 'success' as const,
        verdict: 'done_with_fixes' as const,
      }),
    });
    const out = await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 1 });
    expect(out.outcome).toBe('failed');
    expect(out.loop.status).toBe('exhausted');
  });

  it('does NOT converge when only quality-review passes (spec-review fails)', async () => {
    const deps = makeDeps({
      runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => ({
        invocationId: 'sr-1',
        agentOutcome: 'success' as const,
        verdict: 'fail' as const,
      }),
    });
    const out = await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 1 });
    expect(out.outcome).toBe('failed');
    expect(out.loop.status).toBe('exhausted');
  });

  describe('typecheck gate (post-implement, pre-review)', () => {
    it('returns failed when typecheck fails, without calling spec or quality review', async () => {
      const specSpy = vi.fn<() => Promise<SpecReviewResult>>().mockResolvedValue({
        invocationId: 'sr-1',
        agentOutcome: 'success',
        verdict: 'pass',
      });
      const qualSpy = vi.fn<() => Promise<QualityReviewResult>>().mockResolvedValue({
        invocationId: 'qr-1',
        agentOutcome: 'success',
        verdict: 'pass',
      });
      const deps = makeDeps({
        runTypecheck: async (): Promise<TypecheckResult> => ({
          outcome: 'fail',
          output: 'error TS2345: Type mismatch',
        }),
        runSpecReview: async (_ctx, _tcResult) => specSpy(),
        runQualityReview: async (_ctx, _tcResult) => qualSpy(),
      });
      const out = await new ImplementStepLoop(deps).execute(baseInput());
      expect(out.outcome).toBe('failed');
      expect(specSpy).not.toHaveBeenCalled();
      expect(qualSpy).not.toHaveBeenCalled();
    });

    it('passes typecheck result into spec reviewer', async () => {
      const tcResult: TypecheckResult = { outcome: 'pass', output: 'All good' };
      let capturedTc: TypecheckResult | undefined;
      const deps = makeDeps({
        runTypecheck: async (): Promise<TypecheckResult> => tcResult,
        runSpecReview: async (_ctx, tc) => {
          capturedTc = tc;
          return { invocationId: 'sr-1', agentOutcome: 'success', verdict: 'pass' };
        },
      });
      await new ImplementStepLoop(deps).execute(baseInput());
      expect(capturedTc).toEqual(tcResult);
    });

    it('passes typecheck result into quality reviewer', async () => {
      const tcResult: TypecheckResult = { outcome: 'pass', output: 'All good' };
      let capturedTc: TypecheckResult | undefined;
      const deps = makeDeps({
        runTypecheck: async (): Promise<TypecheckResult> => tcResult,
        runQualityReview: async (_ctx, tc) => {
          capturedTc = tc;
          return { invocationId: 'qr-1', agentOutcome: 'success', verdict: 'pass' };
        },
      });
      await new ImplementStepLoop(deps).execute(baseInput());
      expect(capturedTc).toEqual(tcResult);
    });

    it('re-runs typecheck on iteration 2 after fix and fails when typecheck regresses', async () => {
      let tcCalls = 0;
      let specCalls = 0;
      const qualSpy = vi.fn<() => Promise<QualityReviewResult>>().mockResolvedValue({
        invocationId: 'qr-1',
        agentOutcome: 'success',
        verdict: 'pass',
      });
      const deps = makeDeps({
        runTypecheck: async (): Promise<TypecheckResult> => {
          tcCalls += 1;
          return tcCalls === 1
            ? { outcome: 'pass', output: '' }
            : { outcome: 'fail', output: 'error TS2345 after fix' };
        },
        runSpecReview: async (_ctx, _tcResult) => {
          specCalls += 1;
          return {
            invocationId: `sr-${specCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'fail' as const,
          };
        },
        runQualityReview: async (_ctx, _tcResult) => qualSpy(),
      });
      const out = await new ImplementStepLoop(deps).execute(baseInput());
      expect(out.outcome).toBe('failed');
      expect(tcCalls).toBe(2); // pre-loop + iteration 2 re-run
      // Iteration 1: spec fails → quality runs → fix runs
      // Iteration 2: typecheck re-run fails → spec/quality NOT called
      expect(specCalls).toBe(1);
      expect(qualSpy).toHaveBeenCalledTimes(1);
    });

    it('emits step.typecheck.failed event when typecheck fails', async () => {
      const { events, bus } = collectEvents();
      const deps = makeDeps({
        runTypecheck: async (): Promise<TypecheckResult> => ({
          outcome: 'fail',
          output: 'error TS9999: kaboom',
        }),
      });
      const depsWithBus = { ...deps, events: bus };
      await new ImplementStepLoop(depsWithBus).execute(baseInput());
      const tcFailed = events.find((e) => e.type === 'step.typecheck.failed');
      expect(tcFailed).toBeDefined();
      expect(tcFailed?.level).toBe('error');
    });
  });

  describe('contradiction detection and 1-shot reconciliation', () => {
    it('detects contradiction when fix returns done_no_fixes_needed and spec-review fails', async () => {
      const { events, bus } = collectEvents();
      const deps = makeDeps({
        events: bus,
        runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => ({
          invocationId: 'sr-1',
          agentOutcome: 'success' as const,
          verdict: 'fail' as const,
        }),
        runFix: async () => ({
          invocationId: 'fix-1',
          agentOutcome: 'success' as const,
          verdict: 'done_no_fixes_needed' as const,
          rebuttal: 'The finding is a false positive — named exports satisfy the constraint.',
        }),
      });
      const out = await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 1 });
      // With maxIterations=1 and no arbiter, 1-shot re-run still fails → needs_human_review
      expect(['failed', 'needs_human_review']).toContain(out.outcome);
      const detected = events.filter((e) => e.type === 'review.contradiction.detected');
      expect(detected).toHaveLength(1);
      expect(detected[0]?.level).toBe('warn');
    });

    it('1-shot re-run resolves contradiction when reviewer agrees on re-run', async () => {
      let specCalls = 0;
      const deps = makeDeps({
        runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => {
          specCalls += 1;
          return {
            invocationId: `sr-${specCalls}`,
            agentOutcome: 'success' as const,
            // Iteration 1 review → fail; re-run (2nd call in iteration 1) → pass
            verdict: specCalls === 1 ? ('fail' as const) : ('pass' as const),
          };
        },
        runFix: async () => ({
          invocationId: 'fix-1',
          agentOutcome: 'success' as const,
          verdict: 'done_no_fixes_needed' as const,
          rebuttal: 'Nothing to fix.',
        }),
      });
      const out = await new ImplementStepLoop(deps).execute(baseInput());
      expect(out.outcome).toBe('success');
      expect(out.loop.iterations).toHaveLength(1);
      expect(out.loop.iterations[0]?.outcome).toBe('resolved');
      // spec-review called twice (initial + re-run)
      expect(specCalls).toBe(2);
    });

    it('1-shot re-run only fires once per step (not on every iteration)', async () => {
      // Spec review always fails; fix always says done_no_fixes_needed.
      // Re-run should fire only once for this step.
      let specCalls = 0;
      const deps = makeDeps({
        runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => {
          specCalls += 1;
          return {
            invocationId: `sr-${specCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'fail' as const,
          };
        },
        runFix: async () => ({
          invocationId: 'fix-1',
          agentOutcome: 'success' as const,
          verdict: 'done_no_fixes_needed' as const,
          rebuttal: 'Nothing to fix.',
        }),
      });
      await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 3 });
      // Iteration 1: spec(1) + quality + fix + spec-rerun(2) = 2 spec calls, then no arbiter → needs_human_review
      // The 1-shot re-run is NOT repeated on subsequent iterations
      expect(specCalls).toBe(2); // 1 initial + 1 re-run (not more)
    });

    it('does NOT detect contradiction when fix returns done_with_fixes', async () => {
      const { events, bus } = collectEvents();
      let specCalls = 0;
      const deps = makeDeps({
        events: bus,
        runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => {
          specCalls += 1;
          return {
            invocationId: `sr-${specCalls}`,
            agentOutcome: 'success' as const,
            verdict: specCalls === 1 ? ('fail' as const) : ('pass' as const),
          };
        },
        runFix: async () => ({
          invocationId: 'fix-1',
          agentOutcome: 'success' as const,
          verdict: 'done_with_fixes' as const,
        }),
      });
      await new ImplementStepLoop(deps).execute(baseInput());
      const detected = events.filter((e) => e.type === 'review.contradiction.detected');
      expect(detected).toHaveLength(0);
    });

    it('emits needs_human_review when 1-shot re-run persists and no arbiter is configured', async () => {
      const { events, bus } = collectEvents();
      const deps = makeDeps({
        events: bus,
        runArbiter: undefined,
        runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => ({
          invocationId: 'sr-1',
          agentOutcome: 'success' as const,
          verdict: 'fail' as const,
        }),
        runFix: async () => ({
          invocationId: 'fix-1',
          agentOutcome: 'success' as const,
          verdict: 'done_no_fixes_needed' as const,
          rebuttal: 'Reviewer is wrong.',
        }),
      });
      const out = await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 3 });
      expect(out.outcome).toBe('needs_human_review');
      const nhr = events.filter((e) => e.type === 'needs_human_review');
      expect(nhr).toHaveLength(1);
      expect(nhr[0]?.level).toBe('warn');
    });
  });
});
