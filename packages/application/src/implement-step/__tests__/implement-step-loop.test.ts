import { describe, it, expect, vi } from 'vitest';
import { RunId, PhaseName, AgentProfileName } from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { FakeLoopRepository } from '../../test-doubles/fake-loop-repository.js';
import { ImplementStepLoop } from '../implement-step-loop.js';
import type {
  ImplementStepLoopDeps,
  ImplementResult,
  ImplementStepOptions,
  SpecReviewResult,
  QualityReviewResult,
  FixResult,
  StepLoopContext,
  TypecheckResult,
  ArbiterResult,
  TypescriptError,
  ImplementFixStepOptions,
} from '../types.js';
import type { FixStepOptions } from '../../review-fix/types.js';
import type { EventBusPort } from '../../ports/event-bus-port.js';
import type { GitPort } from '../../ports/git-port.js';

function makeFakeGitPort(opts: {
  headSha: string | string[];
  statusOutput?: string;
  headShaThrows?: boolean;
  statusThrows?: boolean;
}): GitPort {
  let headShaIndex = 0;
  const headShas = Array.isArray(opts.headSha) ? opts.headSha : [opts.headSha];
  return {
    createWorktree: async () => undefined,
    removeWorktree: async () => undefined,
    currentBranch: async () => 'main',
    headCommitSha: async () => {
      if (opts.headShaThrows) throw new Error('rev-parse failed');
      return headShas[headShaIndex++ % headShas.length];
    },
    resetHard: async () => undefined,
    diff: async () => '',
    diffStat: async () => '',
    addAll: async () => undefined,
    commit: async () => 'sha-new',
    push: async () => undefined,
    remoteRef: async () => undefined,
    isAncestor: async () => true,
    logBetween: async () => [],
    cleanUntracked: async () => undefined,
    headCommitShaOf: async () => undefined,
    status: async () => {
      if (opts.statusThrows) throw new Error('status failed');
      return opts.statusOutput ?? '';
    },
    resetWorktreeIfClean: async () => undefined,
  };
}

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
    runImplement: async (
      _ctx: StepLoopContext,
      _opts?: ImplementStepOptions,
    ): Promise<ImplementResult> => ({
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
    implementProfile: AgentProfileName('opencode-frontier'),
    fixProfile: AgentProfileName('pi-qwen-local'),
    fixFallbackProfile: AgentProfileName('opencode-frontier'),
    now: () => new Date('2026-06-17T00:00:00.000Z'),
    idFactory: () => 'loop-1',
    git: undefined,
    ...over,
  };
}

function makeInMemoryImplementHistory(): {
  port: import('../types.js').ImplementStepHistoryPort;
  entries: import('../types.js').ImplementStepHistoryEntry[];
} {
  const entries: import('../types.js').ImplementStepHistoryEntry[] = [];
  return {
    entries,
    port: {
      async read(_ctx: import('../types.js').StepLoopContext) {
        return [...entries];
      },
      async append(
        _ctx: import('../types.js').StepLoopContext,
        entry: import('../types.js').ImplementStepHistoryEntry,
      ) {
        entries.push(entry);
      },
      format(history: import('../types.js').ImplementStepHistoryEntry[]) {
        return history
          .map(
            (e) =>
              `- iteration ${e.iteration} outcome=${e.outcome} fix=${e.fix?.verdict ?? 'none'}` +
              (e.reverted ? ` reverted=${e.reverted.headBeforeFix}` : ''),
          )
          .join('\n');
      },
    },
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

  it('escalates to fallback profile when the initial implement call fails', async () => {
    const { events, bus } = collectEvents();
    let implementCalls = 0;
    const implementCallOptions: ImplementStepOptions[] = [];
    const deps = makeDeps({
      events: bus,
      implementProfile: AgentProfileName('primary-impl'),
      implementFallbackProfile: AgentProfileName('fallback-impl'),
      runImplement: async (_ctx: StepLoopContext, opts?: ImplementStepOptions) => {
        implementCalls += 1;
        implementCallOptions.push(opts ?? {});
        if (implementCalls === 1) {
          return { invocationId: 'impl-1', agentOutcome: 'failed' as const };
        }
        return { invocationId: 'impl-2', agentOutcome: 'success' as const };
      },
    });

    const out = await new ImplementStepLoop(deps).execute(baseInput());

    expect(out.outcome).toBe('success');
    expect(implementCalls).toBe(2);
    expect(implementCallOptions[0]?.useFallback).toBeUndefined();
    expect(implementCallOptions[1]?.useFallback).toBe(true);
    expect(implementCallOptions[1]?.previousInvocationId).toBe('impl-1');

    const esc = events.filter((e) => e.type === 'phase.fallback.escalated');
    expect(esc).toHaveLength(1);
    expect(esc[0]?.metadata.triggerReason).toBe('implement_failed');
    expect(esc[0]?.metadata.fromProfile).toBe('primary-impl');
    expect(esc[0]?.metadata.toProfile).toBe('fallback-impl');
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
    expect(out.loop.iterations).toHaveLength(4);
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
    const appendSpy = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      events: bus,
      loopHistory: {
        read: vi.fn().mockResolvedValue([]),
        format: vi.fn().mockReturnValue(''),
        append: appendSpy,
      },
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
    expect(exhausted[0]?.message).toBe('implement-step loop exhausted after 4 iterations');
    expect(exhausted[0]?.metadata.iterations).toBe(4);
    expect(exhausted[0]?.metadata.maxIterations).toBe(4);
    // The trailing re-review fired on iteration 4 (cap iteration 3 ended
    // `fixed`), so the `loop.trailing_review.started` event is present.
    expect(events.filter((e) => e.type === 'loop.trailing_review.started')).toHaveLength(1);
    expect(appendSpy).toHaveBeenNthCalledWith(
      4,
      expect.anything(),
      expect.objectContaining({ outcome: 'unresolved' }),
    );
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
    expect(found?.iterations.length).toBe(4); // 4 iterations inserted
    // Exercise update path: second read should match persisted state
    const refetch = deps.loops.findById('loop-1');
    expect(refetch?.status).toBe('exhausted');
    expect(refetch?.iterations).toHaveLength(4);
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
    it('retries implement once when typecheck fails, then proceeds to review after typecheck passes', async () => {
      let implementCalls = 0;
      let typecheckCalls = 0;
      let specCalls = 0;
      const deps = makeDeps({
        runImplement: async (_ctx: StepLoopContext, _opts?: ImplementStepOptions) => {
          implementCalls += 1;
          return {
            invocationId: `impl-${implementCalls}`,
            agentOutcome: 'success' as const,
          };
        },
        runTypecheck: async (): Promise<TypecheckResult> => {
          typecheckCalls += 1;
          return typecheckCalls === 1
            ? { outcome: 'fail', output: 'error TS2345: initial type mismatch' }
            : { outcome: 'pass', output: '' };
        },
        runSpecReview: async (_ctx, _tcResult) => {
          specCalls += 1;
          return {
            invocationId: 'sr-1',
            agentOutcome: 'success' as const,
            verdict: 'pass' as const,
          };
        },
      });

      const out = await new ImplementStepLoop(deps).execute(baseInput());

      expect(out.outcome).toBe('success');
      expect(implementCalls).toBe(2);
      expect(typecheckCalls).toBe(2);
      expect(specCalls).toBe(1);
      expect(out.loop.iterations).toHaveLength(1);
      expect(out.loop.iterations[0]?.outcome).toBe('resolved');
    });

    it('passes typecheck errors to implement agent on retry', async () => {
      const retryOptions: Array<ImplementStepOptions | undefined> = [];
      let typecheckCalls = 0;
      const fakeErrors: TypescriptError[] = [
        {
          file: 'src/foo.ts',
          line: 10,
          col: 5,
          code: 'TS2322',
          message: 'string is not assignable to number',
        },
      ];
      const deps = makeDeps({
        runImplement: async (_ctx: StepLoopContext, opts?: ImplementStepOptions) => {
          retryOptions.push(opts);
          return {
            invocationId: `impl-${retryOptions.length}`,
            agentOutcome: 'success' as const,
          };
        },
        runTypecheck: async (): Promise<TypecheckResult> => {
          typecheckCalls += 1;
          return typecheckCalls === 1
            ? {
                outcome: 'fail',
                output: 'src/foo.ts(10,5): error TS2322: string is not assignable to number',
                structuredErrors: fakeErrors,
              }
            : { outcome: 'pass', output: '' };
        },
      });

      const out = await new ImplementStepLoop(deps).execute(baseInput());

      expect(out.outcome).toBe('success');
      expect(retryOptions).toHaveLength(2);
      expect(retryOptions[0]).toBeUndefined();
      expect(retryOptions[1]?.typecheckErrors).toEqual(fakeErrors);
    });

    it('passes raw typecheck output to implement agent on retry when structuredErrors is empty', async () => {
      const retryOptions: Array<ImplementStepOptions | undefined> = [];
      let typecheckCalls = 0;
      const rawOutput = 'Some unparseable build failure output';
      const deps = makeDeps({
        runImplement: async (_ctx: StepLoopContext, opts?: ImplementStepOptions) => {
          retryOptions.push(opts);
          return {
            invocationId: `impl-${retryOptions.length}`,
            agentOutcome: 'success' as const,
          };
        },
        runTypecheck: async (): Promise<TypecheckResult> => {
          typecheckCalls += 1;
          return typecheckCalls === 1
            ? {
                outcome: 'fail',
                output: rawOutput,
                structuredErrors: [],
              }
            : { outcome: 'pass', output: '' };
        },
      });

      const out = await new ImplementStepLoop(deps).execute(baseInput());

      expect(out.outcome).toBe('success');
      expect(retryOptions).toHaveLength(2);
      expect(retryOptions[0]).toBeUndefined();
      expect(retryOptions[1]?.typecheckErrors).toBe(rawOutput);
    });

    it('passes raw typecheck output on retry when raw contains unparsed diagnostics alongside parsed ones', async () => {
      // Repro for PR review #3510440855: when TSC emits a mix of file-prefixed
      // errors (parsed into structuredErrors) AND standalone `error TSxxxx:`
      // lines (NOT parsed by parseTypescriptErrors), the implement agent must
      // still see the unparsed diagnostics. The raw output carries the
      // information; dropping it would leave the typecheck gate red across
      // retries with no signal to the implement agent.
      const retryOptions: Array<ImplementStepOptions | undefined> = [];
      let typecheckCalls = 0;
      const mixedOutput = [
        "src/foo.ts(10,5): error TS2339: Property 'repoId' does not exist",
        "error TS6133: 'foo' is declared but its value is never read.",
      ].join('\n');
      const parsedSubset: TypescriptError[] = [
        {
          file: 'src/foo.ts',
          line: 10,
          col: 5,
          code: 'TS2339',
          message: "Property 'repoId' does not exist",
        },
      ];
      const deps = makeDeps({
        runImplement: async (_ctx: StepLoopContext, opts?: ImplementStepOptions) => {
          retryOptions.push(opts);
          return {
            invocationId: `impl-${retryOptions.length}`,
            agentOutcome: 'success' as const,
          };
        },
        runTypecheck: async (): Promise<TypecheckResult> => {
          typecheckCalls += 1;
          return typecheckCalls === 1
            ? { outcome: 'fail', output: mixedOutput, structuredErrors: parsedSubset }
            : { outcome: 'pass', output: '' };
        },
      });

      const out = await new ImplementStepLoop(deps).execute(baseInput());

      expect(out.outcome).toBe('success');
      expect(retryOptions).toHaveLength(2);
      // Raw output is preferred over the parsed subset so the standalone
      // `error TS6133:` line (which the parser intentionally does not handle)
      // is preserved in the retry prompt.
      expect(retryOptions[1]?.typecheckErrors).toBe(mixedOutput);
    });

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

    it('re-runs typecheck on iteration 2 after fix, reverts build-breaking fix, routes typecheck to next fixer (#671)', async () => {
      let tcCalls = 0;
      let specCalls = 0;
      let qualCalls = 0;
      const fixOptsCapture: ImplementFixStepOptions[] = [];
      const headSha = 'deadbeef';
      const revertSpy = vi.fn().mockResolvedValue(true);
      let tcOutputForCall = (n: number): string => {
        if (n === 1) return '';
        if (n === 2) return 'error TS2345 after fix';
        return '';
      };
      const deps = makeDeps({
        runTypecheck: async (): Promise<TypecheckResult> => {
          tcCalls += 1;
          const out = tcOutputForCall(tcCalls);
          return {
            outcome: out.length === 0 ? 'pass' : 'fail',
            output: out,
            ...(out.includes('TS2345')
              ? {
                  structuredErrors: [
                    { file: 'src/x.ts', line: 1, col: 1, code: 'TS2345', message: 'mismatch' },
                  ],
                }
              : {}),
          };
        },
        runSpecReview: async (_ctx, _tcResult) => {
          specCalls += 1;
          // Spec review passes on every call (so we burn through the fix loop
          // and observe the revert path independently of review findings).
          return {
            invocationId: `sr-${specCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'pass' as const,
          };
        },
        runQualityReview: async (_ctx, _tcResult) => {
          qualCalls += 1;
          return {
            invocationId: `qr-${qualCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'fail' as const,
          };
        },
        runFix: async (
          _ctx: StepLoopContext,
          opts: ImplementFixStepOptions,
        ): Promise<FixResult> => {
          fixOptsCapture.push(opts);
          return {
            invocationId: `fix-${fixOptsCapture.length}`,
            agentOutcome: 'success',
            verdict: 'done_with_fixes',
            headBeforeFix: headSha,
          };
        },
        revertFix: revertSpy,
      });
      const out = await new ImplementStepLoop(deps).execute({
        ...baseInput(),
        maxIterations: 3,
      });
      // After revert the second `runFix` invocation must carry typecheck errors.
      expect(fixOptsCapture.length).toBeGreaterThanOrEqual(2);
      expect(fixOptsCapture[1]?.typecheckErrors).toBeDefined();
      expect(revertSpy).toHaveBeenCalledWith(expect.anything(), headSha);
      // Loop exhausts because quality-review keeps failing across iterations.
      expect(out.outcome).toBe('failed');
      // typecheck was called at least twice (pre-loop + iteration 2 re-run).
      expect(tcCalls).toBeGreaterThanOrEqual(2);
      // spec passes in iteration 1, marked clean, then skipped in subsequent
      // iterations (dirty dimension tracking #723). quality stays dirty and
      // runs every iteration since it keeps failing.
      expect(specCalls).toBe(1);
      expect(qualCalls).toBe(3);
    });

    it('emits step.typecheck.failed event when typecheck fails', async () => {
      const { events, bus } = collectEvents();
      let tcCall = 0;
      const deps = makeDeps({
        runTypecheck: async (): Promise<TypecheckResult> => {
          tcCall += 1;
          // Vary output per call so stall detection does NOT trigger; this test
          // asserts that `step.typecheck.failed` fires when retries exhaust.
          return { outcome: 'fail', output: `error TS9999: kaboom ${tcCall}` };
        },
      });
      const depsWithBus = { ...deps, events: bus };
      await new ImplementStepLoop(depsWithBus).execute(baseInput());
      const tcFailed = events.find((e) => e.type === 'step.typecheck.failed');
      expect(tcFailed).toBeDefined();
      expect(tcFailed?.level).toBe('error');
    });

    it('hard fails when all typecheck retries are exhausted', async () => {
      let implementCalls = 0;
      let typecheckCalls = 0;
      const deps = makeDeps({
        runImplement: async (_ctx: StepLoopContext, _opts?: ImplementStepOptions) => {
          implementCalls += 1;
          return {
            invocationId: `impl-${implementCalls}`,
            agentOutcome: 'success' as const,
          };
        },
        runTypecheck: async (): Promise<TypecheckResult> => {
          typecheckCalls += 1;
          return { outcome: 'fail', output: `error TS9999: failure ${typecheckCalls}` };
        },
      });

      const out = await new ImplementStepLoop(deps).execute({
        ...baseInput(),
        maxTypeCheckRetries: 2,
      });

      expect(out.outcome).toBe('failed');
      expect(implementCalls).toBe(3);
      expect(typecheckCalls).toBe(3);
      expect(out.loop.iterations).toHaveLength(1);
      expect(out.loop.iterations[0]?.outcome).toBe('failed');
    });

    it('respects maxTypeCheckRetries zero by failing immediately without retrying implement', async () => {
      let implementCalls = 0;
      let typecheckCalls = 0;
      const deps = makeDeps({
        runImplement: async (_ctx: StepLoopContext, _opts?: ImplementStepOptions) => {
          implementCalls += 1;
          return {
            invocationId: `impl-${implementCalls}`,
            agentOutcome: 'success' as const,
          };
        },
        runTypecheck: async (): Promise<TypecheckResult> => {
          typecheckCalls += 1;
          return { outcome: 'fail', output: 'error TS1111: no retry' };
        },
      });

      const out = await new ImplementStepLoop(deps).execute({
        ...baseInput(),
        maxTypeCheckRetries: 0,
      });

      expect(out.outcome).toBe('failed');
      expect(implementCalls).toBe(1);
      expect(typecheckCalls).toBe(1);
    });

    it('defaults maxTypeCheckRetries to two when omitted', async () => {
      let implementCalls = 0;
      let typecheckCalls = 0;
      const deps = makeDeps({
        runImplement: async (_ctx: StepLoopContext, _opts?: ImplementStepOptions) => {
          implementCalls += 1;
          return {
            invocationId: `impl-${implementCalls}`,
            agentOutcome: 'success' as const,
          };
        },
        runTypecheck: async (): Promise<TypecheckResult> => {
          typecheckCalls += 1;
          return { outcome: 'fail', output: `error TS2222: default retry ${typecheckCalls}` };
        },
      });

      const out = await new ImplementStepLoop(deps).execute(baseInput());

      expect(out.outcome).toBe('failed');
      expect(implementCalls).toBe(3);
      expect(typecheckCalls).toBe(3);
    });

    it('hard fails when implement agent fails during typecheck retry', async () => {
      let implementCalls = 0;
      let typecheckCalls = 0;
      const deps = makeDeps({
        runImplement: async (_ctx: StepLoopContext, _opts?: ImplementStepOptions) => {
          implementCalls += 1;
          return {
            invocationId: `impl-${implementCalls}`,
            agentOutcome: implementCalls === 1 ? ('success' as const) : ('failed' as const),
          };
        },
        runTypecheck: async (): Promise<TypecheckResult> => {
          typecheckCalls += 1;
          return { outcome: 'fail', output: 'error TS3333: retry implement fails' };
        },
      });

      const out = await new ImplementStepLoop(deps).execute(baseInput());

      expect(out.outcome).toBe('failed');
      expect(implementCalls).toBe(2);
      expect(typecheckCalls).toBe(1);
      expect(out.loop.iterations).toHaveLength(1);
      expect(out.loop.iterations[0]?.outcome).toBe('failed');
    });

    it('emits step.typecheck.retry event on each retry', async () => {
      const { events, bus } = collectEvents();
      let typecheckCalls = 0;
      const deps = makeDeps({
        events: bus,
        runTypecheck: async (): Promise<TypecheckResult> => {
          typecheckCalls += 1;
          return typecheckCalls <= 2
            ? { outcome: 'fail', output: `error TS4444: retry event ${typecheckCalls}` }
            : { outcome: 'pass', output: '' };
        },
      });

      const out = await new ImplementStepLoop(deps).execute({
        ...baseInput(),
        maxTypeCheckRetries: 2,
      });

      expect(out.outcome).toBe('success');
      const retryEvents = events.filter((e) => e.type === 'step.typecheck.retry');
      expect(retryEvents).toHaveLength(2);
      expect(retryEvents[0]?.level).toBe('warn');
      expect(retryEvents[0]?.metadata).toMatchObject({
        attempt: 1,
        maxRetries: 2,
        index: 1,
        output: 'error TS4444: retry event 1',
      });
      expect(retryEvents[1]?.metadata).toMatchObject({
        attempt: 2,
        maxRetries: 2,
        index: 1,
        output: 'error TS4444: retry event 2',
      });
    });
  });

  describe('typecheck stall detection', () => {
    it('stalls and fails immediately when error fingerprint does not change between retries', async () => {
      const stalledErrors: TypescriptError[] = [
        { file: 'src/foo.ts', line: 10, col: 5, code: 'TS2339', message: 'Property missing' },
      ];
      let implementCalls = 0;
      let typecheckCalls = 0;
      const deps = makeDeps({
        runImplement: async () => {
          implementCalls += 1;
          return { invocationId: `impl-${implementCalls}`, agentOutcome: 'success' as const };
        },
        runTypecheck: async (): Promise<TypecheckResult> => {
          typecheckCalls += 1;
          // Same errors every time — stall should trigger
          return {
            outcome: 'fail',
            output: 'src/foo.ts(10,5): error TS2339: Property missing',
            structuredErrors: stalledErrors,
          };
        },
      });

      const out = await new ImplementStepLoop(deps).execute({
        ...baseInput(),
        maxTypeCheckRetries: 5,
      });

      expect(out.outcome).toBe('failed');
      // Should stall after 1 retry (2 implement calls total): initial + 1 retry
      expect(implementCalls).toBe(2);
      expect(typecheckCalls).toBe(2);
    });

    it('does NOT stall when error fingerprint changes between retries', async () => {
      let typecheckCalls = 0;
      const deps = makeDeps({
        runTypecheck: async (): Promise<TypecheckResult> => {
          typecheckCalls += 1;
          if (typecheckCalls === 1) {
            return {
              outcome: 'fail',
              output: 'src/foo.ts(10,5): error TS2339: first error',
              structuredErrors: [
                { file: 'src/foo.ts', line: 10, col: 5, code: 'TS2339', message: 'first error' },
              ],
            };
          }
          if (typecheckCalls === 2) {
            return {
              outcome: 'fail',
              output: 'src/foo.ts(20,3): error TS2339: second error',
              structuredErrors: [
                { file: 'src/foo.ts', line: 20, col: 3, code: 'TS2339', message: 'second error' },
              ],
            };
          }
          return { outcome: 'pass', output: '' };
        },
      });

      const out = await new ImplementStepLoop(deps).execute({
        ...baseInput(),
        maxTypeCheckRetries: 5,
      });

      expect(out.outcome).toBe('success');
      expect(typecheckCalls).toBe(3);
    });

    it('emits step.typecheck.stalled event when stall is detected', async () => {
      const { events, bus } = collectEvents();
      const stalledErrors: TypescriptError[] = [
        { file: 'src/bar.ts', line: 5, col: 1, code: 'TS1005', message: "';' expected" },
      ];
      const deps = makeDeps({
        events: bus,
        runTypecheck: async (): Promise<TypecheckResult> => ({
          outcome: 'fail',
          output: "src/bar.ts(5,1): error TS1005: ';' expected",
          structuredErrors: stalledErrors,
        }),
      });

      await new ImplementStepLoop(deps).execute({ ...baseInput(), maxTypeCheckRetries: 3 });

      const stalledEvent = events.find((e) => e.type === 'step.typecheck.stalled');
      expect(stalledEvent).toBeDefined();
      expect(stalledEvent!.level).toBe('error');
      // Stall path also emits step.typecheck.failed with stalled=true (so the
      // "retries exhausted" contract is satisfied for downstream automation).
      const failedEvent = events.find((e) => e.type === 'step.typecheck.failed');
      expect(failedEvent).toBeDefined();
      expect(failedEvent!.metadata.stalled).toBe(true);
    });

    it('falls back to comparing output string when structuredErrors is empty', async () => {
      let typecheckCalls = 0;
      let implementCalls = 0;
      const deps = makeDeps({
        runImplement: async () => {
          implementCalls += 1;
          return { invocationId: `impl-${implementCalls}`, agentOutcome: 'success' as const };
        },
        runTypecheck: async (): Promise<TypecheckResult> => {
          typecheckCalls += 1;
          // Unparseable output that changes each call — should NOT stall
          return {
            outcome: 'fail',
            output: `Build failed with error code ${typecheckCalls}`,
            structuredErrors: [],
          };
        },
      });

      const out = await new ImplementStepLoop(deps).execute({
        ...baseInput(),
        maxTypeCheckRetries: 2,
      });

      // All retries exhausted (not stalled), because output changes each call
      expect(out.outcome).toBe('failed');
      expect(implementCalls).toBe(3); // initial + 2 retries
    });

    it('stalls when empty structuredErrors and identical output across retries', async () => {
      let implementCalls = 0;
      const deps = makeDeps({
        runImplement: async () => {
          implementCalls += 1;
          return { invocationId: `impl-${implementCalls}`, agentOutcome: 'success' as const };
        },
        runTypecheck: async (): Promise<TypecheckResult> => ({
          outcome: 'fail',
          output: 'Build failed: fatal error',
          structuredErrors: [],
        }),
      });

      const out = await new ImplementStepLoop(deps).execute({
        ...baseInput(),
        maxTypeCheckRetries: 5,
      });

      expect(out.outcome).toBe('failed');
      expect(implementCalls).toBe(2); // stalled after 1 retry
    });

    it('normalizes output before fingerprinting: stalls when volatile lines change but errors are identical', async () => {
      // TSC emits `Found N errors.` summaries that change each retry even when
      // the underlying error set is identical. The fingerprint must normalize
      // these volatile parts so stall detection still fires.
      let implementCalls = 0;
      let typecheckCalls = 0;
      const deps = makeDeps({
        runImplement: async () => {
          implementCalls += 1;
          return { invocationId: `impl-${implementCalls}`, agentOutcome: 'success' as const };
        },
        runTypecheck: async (): Promise<TypecheckResult> => {
          typecheckCalls += 1;
          return {
            outcome: 'fail',
            output: `Build failed: fatal error\nFound ${typecheckCalls} error.\nin ${typecheckCalls}00ms`,
            structuredErrors: [],
          };
        },
      });

      const out = await new ImplementStepLoop(deps).execute({
        ...baseInput(),
        maxTypeCheckRetries: 5,
      });

      expect(out.outcome).toBe('failed');
      expect(implementCalls).toBe(2); // stalled after 1 retry (volatile noise stripped)
    });

    it('detects cyclic regressions (A → B → A → B → A) using the stall history buffer', async () => {
      // With stallHistorySize=2, a regression that oscillates between two
      // distinct error sets should still stall because the current fingerprint
      // matches one of the previous ones in the ring buffer.
      let typecheckCalls = 0;
      let implementCalls = 0;
      const deps = makeDeps({
        runImplement: async () => {
          implementCalls += 1;
          return { invocationId: `impl-${implementCalls}`, agentOutcome: 'success' as const };
        },
        runTypecheck: async (): Promise<TypecheckResult> => {
          typecheckCalls += 1;
          // Alternating error messages → with single-prev comparison this would
          // never stall; with a 2-entry history it stalls as soon as one of the
          // previous fingerprints recurs.
          const message = typecheckCalls % 2 === 1 ? 'error A' : 'error B';
          return {
            outcome: 'fail',
            output: `build error: ${message}`,
            structuredErrors: [],
          };
        },
      });

      const out = await new ImplementStepLoop(deps).execute({
        ...baseInput(),
        maxTypeCheckRetries: 5,
      });

      expect(out.outcome).toBe('failed');
      // Trace:
      //   pre-loop implement: impl #1
      //   typecheck #1 (A)  — history=[]   — push to [A]   — retry → impl #2
      //   typecheck #2 (B)  — history=[A] — push to [A,B] — retry → impl #3
      //   typecheck #3 (A)  — A ∈ [A,B]   — STALL
      expect(typecheckCalls).toBe(3);
      expect(implementCalls).toBe(3);
    });
  });

  describe('parity[#403]: typecheck injection into reviewer prompts', () => {
    it('parity[#403]: runTypecheck is called once after runImplement succeeds', async () => {
      let tcCalls = 0;
      const deps = makeDeps({
        runTypecheck: async (): Promise<TypecheckResult> => {
          tcCalls += 1;
          return { outcome: 'pass', output: '' };
        },
      });
      await new ImplementStepLoop(deps).execute(baseInput());
      expect(tcCalls).toBe(1);
    });

    it('parity[#403]: tcResult is forwarded to runSpecReview under ## TYPECHECK RESULT header', async () => {
      const tcResult: TypecheckResult = { outcome: 'pass', output: 'All good' };
      let capturedTc: TypecheckResult | undefined;
      const deps = makeDeps({
        runTypecheck: async (): Promise<TypecheckResult> => tcResult,
        runSpecReview: async (_ctx: StepLoopContext, tc: TypecheckResult) => {
          capturedTc = tc;
          return { invocationId: 'sr-parity403', agentOutcome: 'success', verdict: 'pass' };
        },
      });
      await new ImplementStepLoop(deps).execute(baseInput());
      expect(capturedTc).toEqual(tcResult);
    });

    it('parity[#403]: tcResult is forwarded to runQualityReview under ## TYPECHECK RESULT header', async () => {
      const tcResult: TypecheckResult = { outcome: 'pass', output: 'All good' };
      let capturedTc: TypecheckResult | undefined;
      const deps = makeDeps({
        runTypecheck: async (): Promise<TypecheckResult> => tcResult,
        runQualityReview: async (_ctx: StepLoopContext, tc: TypecheckResult) => {
          capturedTc = tc;
          return { invocationId: 'qr-parity403', agentOutcome: 'success', verdict: 'pass' };
        },
      });
      await new ImplementStepLoop(deps).execute(baseInput());
      expect(capturedTc).toEqual(tcResult);
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
      expect(out.outcome).toBe('needs_human_review');
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

    it('treats done_no_fixes_needed without rebuttal as extraction failure (schema rejects)', async () => {
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
          agentOutcome: 'contract_violation' as const,
          // Schema rejects done_no_fixes_needed without rebuttal;
          // readFixVerdict returns { ok: false }, so effectiveVerdict is undefined.
          verdict: 'done_no_fixes_needed' as const,
          // No rebuttal — schema will reject
        }),
      });
      const out = await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 1 });
      // The fix is treated as failed (extraction failure), not needs_human_review
      expect(out.outcome).toBe('failed');
      // Should NOT emit needs_human_review for missing rebuttal
      const nhr = events.filter((e) => e.type === 'needs_human_review');
      expect(nhr).toHaveLength(0);
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

  describe('parity[#398]: contradiction reconciliation — fires once, is gated', () => {
    it('parity[#398]: contradiction re-run fires exactly once when fix returns done_no_fixes_needed and spec-review fails', async () => {
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
        runArbiter: async (): Promise<ArbiterResult> => ({
          outcome: 'finding_valid',
          evidence: 'Reviewer is correct.',
          rationale: 'Reviewer is correct.',
        }),
      });
      // Run with 3 iterations; re-run guard must prevent more than 1 extra spec call
      await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 3 });
      // Iteration 1: spec(1) → fix → spec-rerun(2) — guard fires; no further re-runs
      // Iteration 2+: spec(3...) are normal per-iteration calls, NOT re-runs
      // Total spec calls: 1 (iter1 initial) + 1 (iter1 re-run) + up to 2 (iter2, iter3 normal)
      // The re-run count = specCalls - normal iteration calls = at most 1
      // Simplest assertion: specCalls ≤ 4 (3 normal + 1 re-run) and ≥ 2 (1 normal + 1 re-run on iter1)
      expect(specCalls).toBeGreaterThanOrEqual(2);
      expect(specCalls).toBeLessThanOrEqual(4);
    });

    it('parity[#398]: contradiction re-run fires at most once per step (CONTRADICTION_RETRIED guard)', async () => {
      // Spec review always fails; fix always says done_no_fixes_needed.
      // The guard (contradictionRetriedThisStep) must block a second re-run.
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
        runArbiter: async (): Promise<ArbiterResult> => ({
          outcome: 'finding_valid',
          evidence: 'Reviewer is correct.',
          rationale: 'Reviewer is correct.',
        }),
      });
      await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 3 });
      // Iteration 1: spec(1) initial + spec(2) re-run → needs_human_review after re-run fails
      // The 1-shot re-run is NOT repeated on iterations 2 and 3.
      // specCalls == 3: 1 initial + 1 re-run on iter 1 + 1 initial on iter 2 (contradictionRetriedThisStep blocks further re-runs)
      expect(specCalls).toBe(3);
    });

    it('parity[#398]: fires before arbiter — re-run attempt precedes reviews_inconsistent escalation', async () => {
      const { events, bus } = collectEvents();
      let specCalls = 0;
      const deps = makeDeps({
        events: bus,
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
        runArbiter: undefined,
      });
      await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 1 });
      // contradiction.detected fires before needs_human_review (no arbiter path)
      const eventTypes = events.map((e) => e.type);
      const detectedIdx = eventTypes.indexOf('review.contradiction.detected');
      const nhrIdx = eventTypes.indexOf('needs_human_review');
      expect(detectedIdx).toBeGreaterThanOrEqual(0);
      expect(nhrIdx).toBeGreaterThan(detectedIdx);
    });
  });

  describe('arbiter escalation', () => {
    function makeArbiterDeps(
      arbiterOutcome: ArbiterResult['outcome'],
      evidence = 'export * fails pnpm typecheck — named exports are objectively correct.',
    ) {
      const { bus, events } = collectEvents();
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
          rebuttal: 'Named exports satisfy the interface; export * causes name collisions.',
        }),
        runArbiter: async (
          _ctx: StepLoopContext,
          _tcResult: TypecheckResult,
          _fixResult: FixResult,
        ): Promise<ArbiterResult> => ({
          outcome: arbiterOutcome,
          evidence,
          rationale: `Arbiter ruled ${arbiterOutcome} based on deterministic signal.`,
        }),
      });
      return { deps, events };
    }

    it('emits review.contradiction.escalated before calling arbiter', async () => {
      const { deps, events } = makeArbiterDeps('finding_invalid');
      await new ImplementStepLoop(deps).execute(baseInput());
      const esc = events.filter((e) => e.type === 'review.contradiction.escalated');
      expect(esc).toHaveLength(1);
      expect(esc[0]?.level).toBe('warn');
      expect(esc[0]?.metadata.reason).toBeDefined();
    });

    it('finding_invalid: returns success and emits contradiction.resolved', async () => {
      const { deps, events } = makeArbiterDeps('finding_invalid');
      const out = await new ImplementStepLoop(deps).execute(baseInput());
      expect(out.outcome).toBe('success');
      expect(out.loop.iterations[0]?.outcome).toBe('resolved');
      const resolved = events.filter((e) => e.type === 'review.contradiction.resolved');
      expect(resolved).toHaveLength(1);
      expect(resolved[0]?.metadata.ruling).toBe('finding_invalid');
    });

    it('finding_valid: runs one more bounded fix then re-reviews (success path)', async () => {
      const { bus, events } = collectEvents();
      let fixCalls = 0;
      let specCalls = 0;
      const deps = makeDeps({
        events: bus,
        runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => {
          specCalls += 1;
          return {
            invocationId: `sr-${specCalls}`,
            agentOutcome: 'success' as const,
            verdict: specCalls >= 3 ? ('pass' as const) : ('fail' as const),
          };
        },
        runFix: async (_ctx: StepLoopContext, _opts: FixStepOptions) => {
          fixCalls += 1;
          return {
            invocationId: `fix-${fixCalls}`,
            agentOutcome: 'success' as const,
            verdict:
              fixCalls === 1 ? ('done_no_fixes_needed' as const) : ('done_with_fixes' as const),
            rebuttal: fixCalls === 1 ? 'Reviewer is wrong.' : undefined,
          };
        },
        runArbiter: async (): Promise<ArbiterResult> => ({
          outcome: 'finding_valid',
          evidence: 'The reviewer is correct — the fix was not applied.',
          rationale: 'Fixer failed to apply the required change.',
        }),
      });
      const out = await new ImplementStepLoop(deps).execute({
        ...baseInput(),
        maxIterations: 5,
      });
      expect(out.outcome).toBe('success');
      const resolved = events.filter((e) => e.type === 'review.contradiction.resolved');
      expect(resolved).toHaveLength(1);
      expect(resolved[0]?.metadata.ruling).toBe('finding_valid');
    });

    it('finding_valid: bounded fix receives reconciliationContext', async () => {
      const { bus } = collectEvents();
      const capturedOpts: FixStepOptions[] = [];
      let fixCalls = 0;
      let specCalls = 0;
      const deps = makeDeps({
        events: bus,
        runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => {
          specCalls += 1;
          return {
            invocationId: `sr-${specCalls}`,
            agentOutcome: 'success' as const,
            // Need specCalls >= 4: iteration-1 review(1)=fail, rerun(2)=fail,
            // iteration-2 review(3)=fail → fix called, iteration-3 review(4)=pass
            verdict: specCalls >= 4 ? ('pass' as const) : ('fail' as const),
          };
        },
        runFix: async (_ctx: StepLoopContext, opts: FixStepOptions) => {
          fixCalls += 1;
          capturedOpts.push(opts);
          return {
            invocationId: `fix-${fixCalls}`,
            agentOutcome: 'success' as const,
            verdict:
              fixCalls === 1 ? ('done_no_fixes_needed' as const) : ('done_with_fixes' as const),
            rebuttal: fixCalls === 1 ? 'No fix needed.' : undefined,
          };
        },
        runArbiter: async (): Promise<ArbiterResult> => ({
          outcome: 'finding_valid',
          evidence: 'Build fails with export *.',
          rationale: 'The reviewer is correct.',
        }),
      });
      await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 5 });
      // The second fix call (bounded fix) must carry reconciliationContext
      expect(capturedOpts[1]?.reconciliationContext).toBeDefined();
      expect(capturedOpts[1]?.reconciliationContext).toContain('The reviewer is correct.');
    });

    it('ambiguous: returns needs_human_review', async () => {
      const { deps, events } = makeArbiterDeps('ambiguous');
      const out = await new ImplementStepLoop(deps).execute(baseInput());
      expect(out.outcome).toBe('needs_human_review');
      const nhr = events.filter((e) => e.type === 'needs_human_review');
      expect(nhr).toHaveLength(1);
    });

    it('insufficient_evidence: returns needs_human_review', async () => {
      const { deps } = makeArbiterDeps('insufficient_evidence');
      const out = await new ImplementStepLoop(deps).execute(baseInput());
      expect(out.outcome).toBe('needs_human_review');
    });

    it('G1 guardrail: empty arbiter evidence → needs_human_review (never auto-proceed)', async () => {
      const { deps, events } = makeArbiterDeps('finding_invalid', '');
      const out = await new ImplementStepLoop(deps).execute(baseInput());
      expect(out.outcome).toBe('needs_human_review');
      const nhr = events.filter((e) => e.type === 'needs_human_review');
      expect(nhr).toHaveLength(1);
    });

    it('arbiter is bounded: second contradiction after arbiter → needs_human_review', async () => {
      const { bus, events } = collectEvents();
      let fixCalls = 0;
      let specCalls = 0;
      const deps = makeDeps({
        events: bus,
        runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => {
          specCalls += 1;
          return {
            invocationId: `sr-${specCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'fail' as const,
          };
        },
        runFix: async () => {
          fixCalls += 1;
          return {
            invocationId: `fix-${fixCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'done_no_fixes_needed' as const,
            rebuttal: 'Still disagree.',
          };
        },
        runArbiter: async (): Promise<ArbiterResult> => ({
          outcome: 'finding_valid',
          evidence: 'Finding is valid.',
          rationale: 'Fixer must fix.',
        }),
      });
      const out = await new ImplementStepLoop(deps).execute({
        ...baseInput(),
        maxIterations: 10,
      });
      expect(out.outcome).toBe('needs_human_review');
      const esc = events.filter((e) => e.type === 'review.contradiction.escalated');
      expect(esc).toHaveLength(1);
    });
  });

  describe('spec-review retry', () => {
    it('succeeds on first attempt (no retry needed)', async () => {
      let specCalls = 0;
      const deps = makeDeps({
        runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => {
          specCalls += 1;
          return {
            invocationId: `sr-${specCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'pass' as const,
          };
        },
      });
      const out = await new ImplementStepLoop(deps).execute(baseInput());
      expect(out.outcome).toBe('success');
      expect(specCalls).toBe(1);
    });

    it('retries on contract_violation and succeeds on attempt 2', async () => {
      let specCalls = 0;
      const deps = makeDeps({
        runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => {
          specCalls += 1;
          if (specCalls === 1) {
            return { invocationId: 'sr-1', agentOutcome: 'contract_violation' as const };
          }
          return {
            invocationId: 'sr-2',
            agentOutcome: 'success' as const,
            verdict: 'pass' as const,
          };
        },
      });
      const out = await new ImplementStepLoop(deps).execute(baseInput());
      expect(out.outcome).toBe('success');
      expect(specCalls).toBe(2);
    });

    it('retries on undefined verdict (missing result.json) and succeeds on attempt 2', async () => {
      let specCalls = 0;
      const deps = makeDeps({
        runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => {
          specCalls += 1;
          if (specCalls === 1) {
            return { invocationId: 'sr-1', agentOutcome: 'success' as const };
            // verdict undefined — simulates MISSING_REQUIRED_ARTIFACT
          }
          return {
            invocationId: 'sr-2',
            agentOutcome: 'success' as const,
            verdict: 'pass' as const,
          };
        },
      });
      const out = await new ImplementStepLoop(deps).execute(baseInput());
      expect(out.outcome).toBe('success');
      expect(specCalls).toBe(2);
    });

    it('retries on timeout and succeeds on attempt 3', async () => {
      let specCalls = 0;
      const deps = makeDeps({
        runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => {
          specCalls += 1;
          if (specCalls < 3) {
            return { invocationId: `sr-${specCalls}`, agentOutcome: 'timeout' as const };
          }
          return {
            invocationId: 'sr-3',
            agentOutcome: 'success' as const,
            verdict: 'pass' as const,
          };
        },
      });
      const out = await new ImplementStepLoop(deps).execute(baseInput());
      expect(out.outcome).toBe('success');
      expect(specCalls).toBe(3);
    });

    it('does NOT retry when spec-review returns success with a defined verdict (even fail verdict)', async () => {
      let specCalls = 0;
      const deps = makeDeps({
        runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => {
          specCalls += 1;
          return {
            invocationId: 'sr-1',
            agentOutcome: 'success' as const,
            verdict: 'fail' as const,
          };
        },
      });
      // fail verdict proceeds to quality-review and fix, NOT retried
      const out = await new ImplementStepLoop(deps).execute({
        ...baseInput(),
        maxIterations: 1,
      });
      expect(out.outcome).toBe('failed'); // exhausted after 2 iters (1 + trailing)
      expect(specCalls).toBe(2);
    });

    it('hard fails after all 3 attempts fail (exhaustion)', async () => {
      let specCalls = 0;
      const deps = makeDeps({
        runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => {
          specCalls += 1;
          return { invocationId: `sr-${specCalls}`, agentOutcome: 'timeout' as const };
        },
      });
      const out = await new ImplementStepLoop(deps).execute(baseInput());
      expect(out.outcome).toBe('failed');
      expect(out.loop.status).toBe('failed');
      expect(out.loop.iterations[0]?.outcome).toBe('failed');
      expect(specCalls).toBe(3);
    });

    it('emits step.spec-review.retry events for each failed attempt before the last', async () => {
      const { events, bus } = collectEvents();
      let specCalls = 0;
      const deps = makeDeps({
        events: bus,
        runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => {
          specCalls += 1;
          if (specCalls < 3) {
            return { invocationId: `sr-${specCalls}`, agentOutcome: 'contract_violation' as const };
          }
          return {
            invocationId: 'sr-3',
            agentOutcome: 'success' as const,
            verdict: 'pass' as const,
          };
        },
      });
      const out = await new ImplementStepLoop(deps).execute(baseInput());
      expect(out.outcome).toBe('success');
      const retryEvents = events.filter((e) => e.type === 'step.spec-review.retry');
      expect(retryEvents).toHaveLength(2); // attempts 1 and 2 fail, attempt 3 succeeds
      expect(retryEvents[0]?.level).toBe('warn');
      expect(retryEvents[0]?.metadata.attempt).toBe(1);
      expect(retryEvents[0]?.metadata.maxAttempts).toBe(3);
      expect(retryEvents[1]?.metadata.attempt).toBe(2);
    });

    it('emits retry events for undefined verdict and non-success outcome', async () => {
      const { events, bus } = collectEvents();
      let specCalls = 0;
      const deps = makeDeps({
        events: bus,
        runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => {
          specCalls += 1;
          if (specCalls === 1) {
            return { invocationId: 'sr-1', agentOutcome: 'success' as const };
            // verdict undefined, retried
          }
          if (specCalls === 2) {
            return { invocationId: 'sr-2', agentOutcome: 'timeout' as const };
            // timeout, retried
          }
          return {
            invocationId: 'sr-3',
            agentOutcome: 'success' as const,
            verdict: 'pass' as const,
          };
        },
      });
      const out = await new ImplementStepLoop(deps).execute(baseInput());
      expect(out.outcome).toBe('success');
      const retryEvents = events.filter((e) => e.type === 'step.spec-review.retry');
      expect(retryEvents).toHaveLength(2);
      expect(retryEvents[0]?.metadata.agentOutcome).toBe('success');
      expect(retryEvents[0]?.metadata.hasVerdict).toBe(false);
      expect(retryEvents[1]?.metadata.agentOutcome).toBe('timeout');
      expect(retryEvents[1]?.metadata.hasVerdict).toBe(false);
    });
  });
  describe('loopHistory', () => {
    it('reads history and passes context to fixer', async () => {
      const { bus } = collectEvents();
      const readSpy = vi.fn().mockResolvedValue([{ iteration: 1, outcome: 'unresolved' }]);
      const formatSpy = vi.fn().mockReturnValue('## HISTORY');
      const appendSpy = vi.fn().mockResolvedValue(undefined);
      const fixOpts: ImplementFixStepOptions[] = [];
      const deps = makeDeps({
        events: bus,
        loopHistory: {
          read: readSpy,
          format: formatSpy,
          append: appendSpy,
        },
        runSpecReview: async () => ({
          invocationId: 'sr-1',
          agentOutcome: 'success',
          verdict: 'fail',
        }),
        runFix: async (_ctx, opts) => {
          fixOpts.push(opts);
          return { invocationId: 'fix-1', agentOutcome: 'success', verdict: 'done_with_fixes' };
        },
      });
      await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 1 });

      expect(readSpy).toHaveBeenCalled();
      expect(formatSpy).toHaveBeenCalled();
      expect(fixOpts[0]?.historyContext).toBe('## HISTORY');
      expect(appendSpy).toHaveBeenCalled();
      expect(appendSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ outcome: 'fixed' }),
      );
    });

    it('appends revert entries to history when a build-breaking fix is reverted', async () => {
      let tcCalls = 0;
      const appendSpy = vi.fn().mockResolvedValue(undefined);
      const deps = makeDeps({
        runTypecheck: async () => {
          tcCalls += 1;
          return { outcome: tcCalls === 1 ? 'pass' : 'fail', output: 'error TS2345' };
        },
        runSpecReview: async () => ({
          invocationId: 'sr-1',
          agentOutcome: 'success',
          verdict: 'fail',
        }),
        runFix: async () => ({
          invocationId: 'fix-1',
          agentOutcome: 'success',
          verdict: 'done_with_fixes',
          headBeforeFix: 'deadbeef',
        }),
        revertFix: vi.fn().mockResolvedValue(true),
        loopHistory: {
          read: vi.fn().mockResolvedValue([]),
          format: vi.fn().mockReturnValue(''),
          append: appendSpy,
        },
      });
      await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 2 });

      // First iteration append (fixed)
      expect(appendSpy).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        expect.objectContaining({ outcome: 'fixed' }),
      );
      // Second iteration append (reverted, so outcome is unresolved)
      expect(appendSpy).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        expect.objectContaining({
          outcome: 'unresolved',
          reverted: expect.objectContaining({
            headBeforeFix: 'deadbeef',
            typecheckOutputPreview: 'error TS2345',
          }),
        }),
      );
    });
  });

  it('appends a history entry per iteration when loopHistory is wired (#671)', async () => {
    const history = makeInMemoryImplementHistory();
    const deps = makeDeps({ loopHistory: history.port });
    const out = await new ImplementStepLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('success');
    // Iteration 1: both reviews passed → outcome 'resolved'.
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]?.outcome).toBe('resolved');
    expect(history.entries[0]?.specReview.verdict).toBe('pass');
    expect(history.entries[0]?.qualityReview.verdict).toBe('pass');
  });

  it('includes prior history in runFix options when iteration >= 2 (#671)', async () => {
    const history = makeInMemoryImplementHistory();
    const fixOptsCapture: ImplementFixStepOptions[] = [];
    let specCalls = 0;
    let fixCalls = 0;
    const deps = makeDeps({
      loopHistory: history.port,
      runSpecReview: async (
        _ctx: StepLoopContext,
        _tc: TypecheckResult,
      ): Promise<SpecReviewResult> => {
        specCalls += 1;
        return {
          invocationId: `sr-${specCalls}`,
          agentOutcome: 'success' as const,
          verdict: specCalls <= 2 ? ('fail' as const) : ('pass' as const),
        };
      },
      runFix: async (_ctx: StepLoopContext, opts: ImplementFixStepOptions): Promise<FixResult> => {
        fixCalls += 1;
        fixOptsCapture.push(opts);
        return {
          invocationId: `fix-${fixCalls}`,
          agentOutcome: 'success',
          verdict: 'done_with_fixes',
          headBeforeFix: `sha-${fixCalls}`,
        };
      },
    });
    await new ImplementStepLoop(deps).execute(baseInput());
    expect(fixCalls).toBe(2);
    // First fix call (iteration 1) has no historyContext (history is empty).
    expect(fixOptsCapture[0]?.historyContext).toBeUndefined();
    // Second fix call (iteration 2) must carry rendered history.
    expect(fixOptsCapture[1]?.historyContext).toContain('iteration 1');
    expect(fixOptsCapture[1]?.historyContext).toContain('outcome=fixed');
  });

  it('returns needs_human_review when typecheck regresses and revertFix is unavailable (#671)', async () => {
    let tcCalls = 0;
    const deps = makeDeps({
      // No revertFix dep set → fall through to needs_human_review.
      runTypecheck: async (): Promise<TypecheckResult> => {
        tcCalls += 1;
        return tcCalls === 1
          ? { outcome: 'pass', output: '' }
          : { outcome: 'fail', output: 'error TS1128 left uncommitted' };
      },
      runSpecReview: async (_ctx, _tcResult): Promise<SpecReviewResult> => ({
        invocationId: 'sr-1',
        agentOutcome: 'success' as const,
        verdict: 'fail' as const,
      }),
      runQualityReview: async (_ctx, _tcResult): Promise<QualityReviewResult> => ({
        invocationId: 'qr-1',
        agentOutcome: 'success' as const,
        verdict: 'pass' as const,
      }),
    });
    const out = await new ImplementStepLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('needs_human_review');
  });

  it('returns needs_human_review when revertFix throws/fails on a build-breaking fix (#671)', async () => {
    let tcCalls = 0;
    const deps = makeDeps({
      revertFix: async (_ctx, _sha) => false, // simulates revert failure
      runTypecheck: async (): Promise<TypecheckResult> => {
        tcCalls += 1;
        return tcCalls === 1
          ? { outcome: 'pass', output: '' }
          : { outcome: 'fail', output: 'TS9999 boom' };
      },
      runSpecReview: async (_ctx, _tcResult): Promise<SpecReviewResult> => ({
        invocationId: 'sr-1',
        agentOutcome: 'success' as const,
        verdict: 'fail' as const,
      }),
      runQualityReview: async (_ctx, _tcResult): Promise<QualityReviewResult> => ({
        invocationId: 'qr-1',
        agentOutcome: 'success' as const,
        verdict: 'pass' as const,
      }),
    });
    const out = await new ImplementStepLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('needs_human_review');
  });

  describe('ImplementStepLoop fix-commit verifier integration', () => {
    it('records genuine committed fix as fixed when HEAD advanced', async () => {
      const preSha = 'sha-before-fix';
      const postSha = 'sha-after-fix';
      const { events, bus } = collectEvents();
      const git = makeFakeGitPort({ headSha: postSha, statusOutput: '' });
      const deps = makeDeps({
        events: bus,
        runSpecReview: async () => ({
          invocationId: 'sr-1',
          agentOutcome: 'success',
          verdict: 'fail',
        }),
        runFix: async () => ({
          invocationId: 'f1',
          agentOutcome: 'success' as const,
          verdict: 'done_with_fixes' as const,
          headBeforeFix: preSha,
        }),
        git,
      });
      // Use a path that immediately reaches the fix branch
      const out = await new ImplementStepLoop(deps).execute({
        runId: RunId('run-1'),
        phaseId: PhaseName('implement'),
        repoId: 'o/r',
        cwd: '/wt',
        stepIndex: 1,
        stepTitle: 's',
        maxIterations: 3,
      });
      expect(out.loop.iterations.some((it) => it.outcome === 'fixed')).toBe(true);
      expect(events.find((e) => e.type === 'fix.uncommitted_changes')).toBeUndefined();
      expect(events.find((e) => e.type === 'fix.no_commit_claimed')).toBeUndefined();
    });

    it('downgrades done_with_fixes + dirty worktree to unresolved with fix.uncommitted_changes; auto-commits if typecheck passes', async () => {
      const { events, bus } = collectEvents();
      const git = makeFakeGitPort({
        headSha: 'sha-before-fix',
        statusOutput: ' M packages/foo.ts\n',
      });
      const deps = makeDeps({
        events: bus,
        runSpecReview: async () => ({
          invocationId: 'sr-1',
          agentOutcome: 'success',
          verdict: 'fail',
        }),
        runFix: async () => ({
          invocationId: 'f1',
          agentOutcome: 'success' as const,
          verdict: 'done_with_fixes' as const,
          headBeforeFix: 'sha-before-fix',
        }),
        git,
        runTypecheck: async () => ({ outcome: 'pass', output: '' }),
      });
      await new ImplementStepLoop(deps).execute({
        runId: RunId('run-1'),
        phaseId: PhaseName('implement'),
        repoId: 'o/r',
        cwd: '/wt',
        stepIndex: 1,
        stepTitle: 's',
        maxIterations: 3,
      });
      expect(events.find((e) => e.type === 'fix.uncommitted_changes')).toBeDefined();
      expect(events.find((e) => e.type === 'fix.auto_commit.succeeded')).toBeDefined();
    });

    it('downgrades done_with_fixes + clean tree to unresolved with fix.no_commit_claimed', async () => {
      const { events, bus } = collectEvents();
      const git = makeFakeGitPort({ headSha: 'sha-before-fix', statusOutput: '' });
      const deps = makeDeps({
        events: bus,
        runSpecReview: async () => ({
          invocationId: 'sr-1',
          agentOutcome: 'success',
          verdict: 'fail',
        }),
        runFix: async () => ({
          invocationId: 'f1',
          agentOutcome: 'success' as const,
          verdict: 'done_with_fixes' as const,
          headBeforeFix: 'sha-before-fix',
        }),
        git,
      });
      await new ImplementStepLoop(deps).execute({
        runId: RunId('run-1'),
        phaseId: PhaseName('implement'),
        repoId: 'o/r',
        cwd: '/wt',
        stepIndex: 1,
        stepTitle: 's',
        maxIterations: 3,
      });
      const ev = events.find((e) => e.type === 'fix.no_commit_claimed');
      expect(ev).toBeDefined();
    });
  });

  describe('endOnReview trailing re-review (#680)', () => {
    it('grants one trailing re-review when cap iteration ends fixed and trailing reviews pass', async () => {
      let specReviewCalls = 0;
      const { events, bus } = collectEvents();
      const deps = makeDeps({
        events: bus,
        runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => {
          specReviewCalls += 1;
          return {
            invocationId: `sr-${specReviewCalls}`,
            agentOutcome: 'success' as const,
            // Trailing pass (call 3) returns 'pass'; iterations 1 and 2 fail.
            verdict: specReviewCalls < 3 ? ('fail' as const) : ('pass' as const),
          };
        },
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
      });
      const out = await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 2 });
      // Iteration 1: spec-review fail + quality-review pass + fix done_with_fixes → fixed
      // Iteration 2: spec-review fail + quality-review pass + fix done_with_fixes → fixed (cap)
      // Trailing (iteration 3): spec-review pass + quality-review pass → resolved
      expect(out.outcome).toBe('success');
      expect(out.loop.status).toBe('converged');
      expect(out.loop.iterations).toHaveLength(3);
      expect(out.loop.iterations[0]?.outcome).toBe('fixed');
      expect(out.loop.iterations[1]?.outcome).toBe('fixed');
      expect(out.loop.iterations[2]?.outcome).toBe('resolved');
      expect(specReviewCalls).toBe(3);
      const trailing = events.filter((e) => e.type === 'loop.trailing_review.started');
      expect(trailing).toHaveLength(1);
      expect(trailing[0]?.level).toBe('info');
      expect(trailing[0]?.metadata.iteration).toBe(3);
      expect(trailing[0]?.metadata.originalMax).toBe(2);
      expect(trailing[0]?.metadata.lastOutcome).toBe('fixed');
    });

    it('exhausts when trailing pass reviews fail (no second trailing pass)', async () => {
      let specReviewCalls = 0;
      const deps = makeDeps({
        runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => {
          specReviewCalls += 1;
          // All three reviews fail.
          return {
            invocationId: `sr-${specReviewCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'fail' as const,
          };
        },
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
      });
      const out = await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 2 });
      // Iteration 1: spec-review fail + quality-review pass + fix → fixed
      // Iteration 2: spec-review fail + quality-review pass + fix → fixed (cap, trailing fires)
      // Trailing (iteration 3): spec-review fail → trailing pass exhausts
      expect(out.outcome).toBe('failed');
      expect(out.loop.status).toBe('exhausted');
      expect(out.loop.iterations).toHaveLength(3);
      expect(out.loop.iterations[0]?.outcome).toBe('fixed');
      expect(out.loop.iterations[1]?.outcome).toBe('fixed');
      expect(out.loop.iterations[2]?.outcome).toBe('unresolved');
      // No second trailing pass after the trailing pass exhausts.
      expect(specReviewCalls).toBe(3);
    });

    it('does NOT grant a trailing re-review when the cap iteration ends unresolved', async () => {
      let specReviewCalls = 0;
      const { events, bus } = collectEvents();
      const deps = makeDeps({
        events: bus,
        runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => {
          specReviewCalls += 1;
          return {
            invocationId: `sr-${specReviewCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'fail' as const,
          };
        },
        runQualityReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => ({
          invocationId: 'qr-1',
          agentOutcome: 'success' as const,
          verdict: 'pass' as const,
        }),
        // cannot_fix produces `outcome: 'unresolved'` at iteration 2 (cap).
        runFix: async () => ({
          invocationId: 'fix-1',
          agentOutcome: 'success' as const,
          verdict: 'cannot_fix' as const,
        }),
      });
      const out = await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 2 });
      // Iteration 1: spec-review fail + quality-review pass + fix cannot_fix → unresolved
      // Iteration 2: spec-review fail + quality-review pass + fix cannot_fix → unresolved (cap)
      // No trailing pass (last outcome is 'unresolved', not 'fixed').
      expect(out.outcome).toBe('failed');
      expect(out.loop.status).toBe('exhausted');
      expect(out.loop.iterations).toHaveLength(2);
      expect(out.loop.iterations[0]?.outcome).toBe('unresolved');
      expect(out.loop.iterations[1]?.outcome).toBe('unresolved');
      expect(events.filter((e) => e.type === 'loop.trailing_review.started')).toHaveLength(0);
      expect(specReviewCalls).toBe(2);
    });

    it('does NOT grant a trailing re-review when endOnReview=false (opt-out)', async () => {
      let specReviewCalls = 0;
      const { events, bus } = collectEvents();
      const deps = makeDeps({
        events: bus,
        runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => {
          specReviewCalls += 1;
          return {
            invocationId: `sr-${specReviewCalls}`,
            agentOutcome: 'success' as const,
            verdict: specReviewCalls < 3 ? ('fail' as const) : ('pass' as const),
          };
        },
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
      });
      const out = await new ImplementStepLoop(deps).execute({
        ...baseInput(),
        maxIterations: 2,
        options: { endOnReview: false },
      });
      // Iteration 1: spec-review fail + quality-review pass + fix → fixed
      // Iteration 2: spec-review fail + quality-review pass + fix → fixed (cap)
      // No trailing pass (endOnReview=false).
      expect(out.outcome).toBe('failed');
      expect(out.loop.status).toBe('exhausted');
      expect(out.loop.iterations).toHaveLength(2);
      expect(out.loop.iterations[0]?.outcome).toBe('fixed');
      expect(out.loop.iterations[1]?.outcome).toBe('fixed');
      expect(events.filter((e) => e.type === 'loop.trailing_review.started')).toHaveLength(0);
      expect(specReviewCalls).toBe(2);
    });

    it('returns needs_human_review when typecheck fails on trailing pass (no revert is attempted)', async () => {
      let typecheckCalls = 0;
      let specReviewCalls = 0;
      const revertSpy = vi.fn().mockResolvedValue(true);
      const deps = makeDeps({
        revertFix: revertSpy,
        runTypecheck: async (): Promise<TypecheckResult> => {
          typecheckCalls += 1;
          // Iteration 1: pass
          // Iteration 2: pass
          // Iteration 3 (trailing): fail
          return {
            outcome: typecheckCalls === 3 ? 'fail' : 'pass',
            output: typecheckCalls === 3 ? 'error TS2345 trailing fail' : '',
          };
        },
        runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => {
          specReviewCalls += 1;
          return {
            invocationId: `sr-${specReviewCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'fail' as const,
          };
        },
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
      });
      const out = await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 2 });

      expect(out.outcome).toBe('needs_human_review');
      expect(out.loop.status).toBe('failed');
      expect(out.loop.iterations).toHaveLength(3);
      expect(out.loop.iterations[2]?.outcome).toBe('failed');
      expect(revertSpy).not.toHaveBeenCalled();
    });
  });

  describe('trailing re-review arbiter escalation (#690)', () => {
    it('AC #1 — trailing-fail + arbiter finding_invalid → success', async () => {
      let specReviewCalls = 0;
      const { events, bus } = collectEvents();
      const deps = makeDeps({
        events: bus,
        runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => {
          specReviewCalls += 1;
          // Iterations 1 and 2 fail; trailing pass (call 3) also fails —
          // the arbiter is what converts it to success.
          return {
            invocationId: `sr-${specReviewCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'fail' as const,
          };
        },
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
        runFinalReviewArbiter: async (): Promise<ArbiterResult> => ({
          outcome: 'finding_invalid',
          evidence: 'typecheck passes and the flagged code matches the plan task body',
          rationale: 'the reviewer misread the plan task body',
        }),
      });
      const out = await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 2 });
      // Iteration 1: spec-review fail + quality-review pass + fix → fixed
      // Iteration 2: spec-review fail + quality-review pass + fix → fixed (cap, trailing fires)
      // Trailing (iteration 3): spec-review fail → arbiter finding_invalid → resolved
      expect(out.outcome).toBe('success');
      // Note: completeIteration({outcome: 'resolved'}) internally transitions the loop status to 'converged'
      expect(out.loop.status).toBe('converged');
      expect(out.loop.iterations).toHaveLength(3);
      expect(out.loop.iterations[2]?.outcome).toBe('resolved');

      // Assert event ordering and counts explicitly
      const completed = events.filter((e) => e.type === 'loop.iteration.completed');
      expect(completed).toHaveLength(3);
      expect(completed[0]?.metadata.outcome).toBe('fixed');
      expect(completed[1]?.metadata.outcome).toBe('fixed');
      expect(completed[2]?.metadata.outcome).toBe('resolved');
      expect(completed[2]?.metadata.resolvedBy).toBe('trailing-review-arbiter');

      const escalated = events.filter((e) => e.type === 'loop.trailing_review.arbiter_escalated');
      expect(escalated).toHaveLength(1);
      expect(escalated[0]?.metadata.iterationIndex).toBe(3);
      expect(escalated[0]?.metadata.reason).toBe('trailing_review_fail');

      const resolved = events.filter((e) => e.type === 'loop.trailing_review.arbiter_resolved');
      expect(resolved).toHaveLength(1);
      expect(resolved[0]?.metadata.resolvedBy).toBe('trailing-review-arbiter');

      // Verify overall chronological ordering of the trailing pass events robustly
      const startIndex = events.findIndex((e) => e.type === 'loop.trailing_review.started');
      expect(startIndex).toBeGreaterThanOrEqual(0);
      const sequence = events
        .slice(startIndex)
        .map((e) => e.type)
        .filter((type) =>
          [
            'loop.trailing_review.started',
            'loop.trailing_review.arbiter_escalated',
            'loop.trailing_review.arbiter_resolved',
            'loop.iteration.completed',
          ].includes(type),
        );
      expect(sequence).toEqual([
        'loop.trailing_review.started',
        'loop.trailing_review.arbiter_escalated',
        'loop.trailing_review.arbiter_resolved',
        'loop.iteration.completed',
      ]);
    });

    it('AC #3 (regression) — trailing-fail + no arbiter configured → exhausts/fails unchanged', async () => {
      let specReviewCalls = 0;
      const { events, bus } = collectEvents();
      const deps = makeDeps({
        events: bus,
        runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => {
          specReviewCalls += 1;
          return {
            invocationId: `sr-${specReviewCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'fail' as const,
          };
        },
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
        runFinalReviewArbiter: undefined,
      });
      const out = await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 2 });
      expect(out.outcome).toBe('failed');
      expect(out.loop.status).toBe('exhausted');
      expect(out.loop.iterations).toHaveLength(3);
      expect(out.loop.iterations[2]?.outcome).toBe('unresolved');
      expect(
        events.filter((e) => e.type === 'loop.trailing_review.arbiter_escalated'),
      ).toHaveLength(0);

      const completed = events.filter((e) => e.type === 'loop.iteration.completed');
      expect(completed).toHaveLength(3);
      expect(completed[0]?.metadata.outcome).toBe('fixed');
      expect(completed[1]?.metadata.outcome).toBe('fixed');
      expect(completed[2]?.metadata.outcome).toBe('unresolved');
    });

    it('AC #2/#3 — trailing-fail + arbiter finding_valid → exhausts/fails (no retry loop)', async () => {
      let specReviewCalls = 0;
      let arbiterCalls = 0;
      const { events, bus } = collectEvents();
      const deps = makeDeps({
        events: bus,
        runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => {
          specReviewCalls += 1;
          return {
            invocationId: `sr-${specReviewCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'fail' as const,
          };
        },
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
        runFinalReviewArbiter: async (): Promise<ArbiterResult> => {
          arbiterCalls += 1;
          return {
            outcome: 'finding_valid',
            evidence: 'typecheck fails on the exact line the reviewer flagged',
            rationale: 'the reviewer is right; the fix is incomplete',
          };
        },
        options: { bonusIteration: false },
      });
      const out = await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 2 });
      expect(out.outcome).toBe('failed');
      expect(out.loop.status).toBe('exhausted');
      expect(out.loop.iterations).toHaveLength(3);
      expect(out.loop.iterations[2]?.outcome).toBe('unresolved');
      // Arbiter invoked exactly once — finding_valid does not retry another pass.
      expect(arbiterCalls).toBe(1);
      expect(specReviewCalls).toBe(3);
      expect(
        events.filter((e) => e.type === 'loop.trailing_review.arbiter_escalated'),
      ).toHaveLength(1);

      const completed = events.filter((e) => e.type === 'loop.iteration.completed');
      expect(completed).toHaveLength(3);
      expect(completed[2]?.metadata.outcome).toBe('unresolved');
    });

    it('AC #690 guardrail — trailing arbiter returns finding_invalid with empty evidence → needs_human_review (pins down empty-evidence-first check order)', async () => {
      let specReviewCalls = 0;
      const { events, bus } = collectEvents();
      const deps = makeDeps({
        events: bus,
        runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => {
          specReviewCalls += 1;
          return {
            invocationId: `sr-${specReviewCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'fail' as const,
          };
        },
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
        runFinalReviewArbiter: async (): Promise<ArbiterResult> => ({
          outcome: 'finding_invalid',
          evidence: '   ',
          rationale: 'whitespace-only evidence must be treated as empty',
        }),
      });
      const out = await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 2 });
      // If ordering were wrong (outcome checked first), it would return success.
      // Since ordering is correct (evidence first), it returns needs_human_review.
      expect(out.outcome).toBe('needs_human_review');
      expect(out.loop.iterations).toHaveLength(3);
      expect(out.loop.iterations[2]?.outcome).toBe('failed');
      const humanReview = events.filter((e) => e.type === 'needs_human_review');
      expect(humanReview).toHaveLength(1);
      expect(
        events.filter((e) => e.type === 'loop.trailing_review.arbiter_escalated'),
      ).toHaveLength(1);

      // Verify that loop.iteration.completed is NOT emitted for iteration 3 because it short-circuited to needs_human_review
      const completed = events.filter((e) => e.type === 'loop.iteration.completed');
      expect(completed).toHaveLength(2); // only iteration 1 and 2
    });

    it('AC #690 guardrail — trailing arbiter returns insufficient_evidence with non-empty evidence → exhausts/fails (ordering check validation)', async () => {
      let specReviewCalls = 0;
      const { events, bus } = collectEvents();
      const deps = makeDeps({
        events: bus,
        runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => {
          specReviewCalls += 1;
          return {
            invocationId: `sr-${specReviewCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'fail' as const,
          };
        },
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
        runFinalReviewArbiter: async (): Promise<ArbiterResult> => ({
          outcome: 'insufficient_evidence',
          evidence: 'non-empty evidence provided',
          rationale: 'non-empty evidence but inconclusive outcome',
        }),
      });
      const out = await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 2 });
      // Shipped outcome is failed (exhausts), not success or needs_human_review.
      expect(out.outcome).toBe('failed');
      expect(out.loop.status).toBe('exhausted');
      expect(out.loop.iterations).toHaveLength(3);
      expect(out.loop.iterations[2]?.outcome).toBe('unresolved');
      expect(
        events.filter((e) => e.type === 'loop.trailing_review.arbiter_escalated'),
      ).toHaveLength(1);
      expect(events.filter((e) => e.type === 'loop.trailing_review.arbiter_resolved')).toHaveLength(
        0,
      );

      const completed = events.filter((e) => e.type === 'loop.iteration.completed');
      expect(completed).toHaveLength(3);
      expect(completed[2]?.metadata.outcome).toBe('unresolved');
    });

    // Regression check for existing behavior: verifying that trailing-pass typecheck failures
    // continue to exit early to needs_human_review at line 486 and thus never invoke the arbiter.
    it('AC #690 guardrail — trailing pass typecheck fail does NOT invoke arbiter', async () => {
      let typecheckCalls = 0;
      let arbiterCalls = 0;
      const { events, bus } = collectEvents();
      const deps = makeDeps({
        events: bus,
        runTypecheck: async (): Promise<TypecheckResult> => {
          typecheckCalls += 1;
          return {
            outcome: typecheckCalls === 3 ? 'fail' : 'pass',
            output: typecheckCalls === 3 ? 'error TS2345 trailing fail' : '',
          };
        },
        runSpecReview: async () => ({
          invocationId: 'sr-1',
          agentOutcome: 'success' as const,
          verdict: 'fail' as const,
        }),
        runQualityReview: async () => ({
          invocationId: 'qr-1',
          agentOutcome: 'success' as const,
          verdict: 'pass' as const,
        }),
        runFix: async () => ({
          invocationId: 'fix-1',
          agentOutcome: 'success' as const,
          verdict: 'done_with_fixes' as const,
        }),
        runFinalReviewArbiter: async (): Promise<ArbiterResult> => {
          arbiterCalls += 1;
          return {
            outcome: 'finding_invalid',
            evidence: 'should not be called',
            rationale: '',
          };
        },
      });
      const out = await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 2 });
      expect(out.outcome).toBe('needs_human_review');
      expect(arbiterCalls).toBe(0);
      expect(
        events.filter((e) => e.type === 'loop.trailing_review.arbiter_escalated'),
      ).toHaveLength(0);
    });

    it('bonus iteration — trailing arbiter finding_valid triggers bonus fix → succeeds', async () => {
      let specReviewCalls = 0;
      let fixCalls = 0;
      let arbiterCalls = 0;
      const { events, bus } = collectEvents();
      const deps = makeDeps({
        events: bus,
        runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => {
          specReviewCalls += 1;
          // Iterations 1, 2: fail
          // Iteration 3 (trailing): fail
          // Iteration 4 (bonus trailing): pass
          return {
            invocationId: `sr-${specReviewCalls}`,
            agentOutcome: 'success' as const,
            verdict: specReviewCalls === 4 ? ('pass' as const) : ('fail' as const),
          };
        },
        runQualityReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => ({
          invocationId: 'qr-1',
          agentOutcome: 'success' as const,
          verdict: 'pass' as const,
        }),
        runFix: async () => {
          fixCalls += 1;
          return {
            invocationId: `fix-${fixCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'done_with_fixes' as const,
            headBeforeFix: 'sha-before',
          };
        },
        runFinalReviewArbiter: async (): Promise<ArbiterResult> => {
          arbiterCalls += 1;
          return {
            outcome: 'finding_valid',
            evidence: 'P0 confirmed',
            rationale: 'fix it',
          };
        },
      });

      const out = await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 2 });
      expect(out.outcome).toBe('success');
      expect(out.loop.iterations).toHaveLength(4);
      expect(arbiterCalls).toBe(1);
      expect(fixCalls).toBe(3); // 2 original + 1 bonus
      expect(specReviewCalls).toBe(4); // 2 original + 1 trailing + 1 bonus-trailing

      expect(events.map((e) => e.type)).toContain('loop.trailing_review.bonus_fix_iteration');
    });

    it('bonus iteration — capped at one (escalates to human if bonus fix does not converge)', async () => {
      let specReviewCalls = 0;
      const { bus } = collectEvents();
      const deps = makeDeps({
        events: bus,
        runSpecReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => {
          specReviewCalls += 1;
          return {
            invocationId: `sr-${specReviewCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'fail' as const,
          };
        },
        runQualityReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => ({
          invocationId: 'qr-1',
          agentOutcome: 'success' as const,
          verdict: 'pass' as const,
        }),
        runFix: async () => ({
          invocationId: 'fix-x',
          agentOutcome: 'success' as const,
          verdict: 'done_with_fixes' as const,
          headBeforeFix: 'sha-before',
        }),
        runFinalReviewArbiter: async (): Promise<ArbiterResult> => ({
          outcome: 'finding_valid',
          evidence: 'real defect',
          rationale: 'still broken',
        }),
      });

      const out = await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 2 });
      expect(out.outcome).toBe('failed'); // exhausts
      expect(out.loop.status).toBe('exhausted');
      expect(out.loop.iterations).toHaveLength(4); // 2 original + 1 trailing + 1 bonus-trailing
      expect(specReviewCalls).toBe(4);
    });

    it('bonus iteration — can be disabled via options', async () => {
      let arbiterCalls = 0;
      const { bus } = collectEvents();
      const deps = makeDeps({
        events: bus,
        runSpecReview: async () => ({
          invocationId: 'sr-x',
          agentOutcome: 'success' as const,
          verdict: 'fail' as const,
        }),
        runFix: async () => ({
          invocationId: 'fix-x',
          agentOutcome: 'success' as const,
          verdict: 'done_with_fixes' as const,
        }),
        runFinalReviewArbiter: async (): Promise<ArbiterResult> => {
          arbiterCalls += 1;
          return {
            outcome: 'finding_valid',
            evidence: 'real defect',
            rationale: 'fix it',
          };
        },
        options: { bonusIteration: false },
      });

      const out = await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 2 });
      expect(out.outcome).toBe('failed');
      expect(out.loop.iterations).toHaveLength(3);
      expect(arbiterCalls).toBe(1);
    });
  });

  describe('quality-review retry', () => {
    it('retries on contract_violation and succeeds on attempt 2', async () => {
      let qualityCalls = 0;
      const deps = makeDeps({
        runQualityReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => {
          qualityCalls += 1;
          if (qualityCalls === 1) {
            return { invocationId: 'qr-1', agentOutcome: 'contract_violation' as const };
          }
          return {
            invocationId: 'qr-2',
            agentOutcome: 'success' as const,
            verdict: 'pass' as const,
          };
        },
      });
      const out = await new ImplementStepLoop(deps).execute(baseInput());
      // Expectation BEFORE FIX: outcome: 'failed', iterations: 1, qualityCalls: 1
      // Expectation AFTER FIX: outcome: 'success', iterations: 1, qualityCalls: 2
      expect(out.outcome).toBe('success');
      expect(qualityCalls).toBe(2);
    });

    it('hard fails after all 3 quality-review attempts fail (exhaustion)', async () => {
      let qualityCalls = 0;
      const deps = makeDeps({
        runQualityReview: async (_ctx: StepLoopContext, _tcResult: TypecheckResult) => {
          qualityCalls += 1;
          return { invocationId: `qr-${qualityCalls}`, agentOutcome: 'timeout' as const };
        },
      });
      const out = await new ImplementStepLoop(deps).execute(baseInput());
      expect(out.outcome).toBe('failed');
      expect(out.loop.status).toBe('failed');
      expect(out.loop.iterations[0]?.outcome).toBe('failed');
      expect(qualityCalls).toBe(3);
    });
  });
});

describe('ImplementStepLoop auto-commit fallback', () => {
  const baseInput = () => ({
    runId: RunId('run-1'),
    phaseId: PhaseName('implement'),
    repoId: 'repo-1',
    cwd: '/wt',
    stepIndex: 1,
    stepTitle: 'step 1',
    maxIterations: 2,
  });

  it('auto-commits when dirty worktree passes typecheck', async () => {
    const { events, bus } = collectEvents();
    const git = makeFakeGitPort({ headSha: 'sha-1', statusOutput: 'M file.ts' });
    let commitCalled = false;
    let addAllCalled = false;
    git.addAll = async () => {
      addAllCalled = true;
    };
    git.commit = async (cwd, message) => {
      commitCalled = true;
      expect(message).toContain('(auto-committed — agent left changes uncommitted)');
      return 'sha-2';
    };

    const deps = makeDeps({
      events: bus,
      git,
      runImplement: async () => ({ invocationId: 'i1', agentOutcome: 'success' }),
      runTypecheck: async () => ({ outcome: 'pass', output: '' }),
      runSpecReview: async () => ({
        invocationId: 'sr1',
        agentOutcome: 'success',
        verdict: 'fail',
      }),
      runQualityReview: async () => ({
        invocationId: 'qr1',
        agentOutcome: 'success',
        verdict: 'pass',
      }),
      runFix: async () => ({
        invocationId: 'f1',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
        headBeforeFix: 'sha-1',
      }),
    });

    const result = await new ImplementStepLoop(deps).execute(baseInput());
    expect(addAllCalled).toBe(true);
    expect(commitCalled).toBe(true);
    expect(events.find((e) => e.type === 'fix.auto_commit.succeeded')).toBeDefined();
    // Iteration 1 is implement + initial TC (pass). Then it enters review-fix loop.
    // In review-fix iteration 1: spec-fail -> fix -> uncommitted -> TC(pass) -> auto-commit -> fixed.
    expect(result.loop.iterations[0].outcome).toBe('fixed');
  });

  it('retries once on git lock error and succeeds', async () => {
    const { events, bus } = collectEvents();
    const git = makeFakeGitPort({ headSha: 'sha-1', statusOutput: 'M file.ts' });
    let attempts = 0;
    git.commit = async () => {
      attempts++;
      if (attempts === 1) throw new Error('Unable to create .git/index.lock');
      return 'sha-2';
    };

    const deps = makeDeps({
      events: bus,
      git,
      runImplement: async () => ({ invocationId: 'i1', agentOutcome: 'success' }),
      runTypecheck: async () => ({ outcome: 'pass', output: '' }),
      runSpecReview: async () => ({
        invocationId: 'sr1',
        agentOutcome: 'success',
        verdict: 'fail',
      }),
      runQualityReview: async () => ({
        invocationId: 'qr1',
        agentOutcome: 'success',
        verdict: 'pass',
      }),
      runFix: async () => ({
        invocationId: 'f1',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
        headBeforeFix: 'sha-1',
      }),
    });

    const result = await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 1 });
    expect(attempts).toBe(2);
    expect(events.find((e) => e.type === 'fix.auto_commit.retry')).toBeDefined();
    expect(events.find((e) => e.type === 'fix.auto_commit.succeeded')).toBeDefined();
    expect(result.loop.iterations[0].outcome).toBe('fixed');
  });

  it('retries once on git lock error and fails if still locked', async () => {
    const { events, bus } = collectEvents();
    const git = makeFakeGitPort({ headSha: 'sha-1', statusOutput: 'M file.ts' });
    let attempts = 0;
    git.commit = async () => {
      attempts++;
      throw new Error('Unable to create .git/index.lock');
    };

    const deps = makeDeps({
      events: bus,
      git,
      runImplement: async () => ({ invocationId: 'i1', agentOutcome: 'success' }),
      runTypecheck: async () => ({ outcome: 'pass', output: '' }),
      runSpecReview: async () => ({
        invocationId: 'sr1',
        agentOutcome: 'success',
        verdict: 'fail',
      }),
      runQualityReview: async () => ({
        invocationId: 'qr1',
        agentOutcome: 'success',
        verdict: 'pass',
      }),
      runFix: async () => ({
        invocationId: 'f1',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
        headBeforeFix: 'sha-1',
      }),
    });

    const result = await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 1 });
    expect(attempts).toBe(2);
    expect(events.find((e) => e.type === 'fix.auto_commit.retry')).toBeDefined();
    expect(events.find((e) => e.type === 'fix.auto_commit.failed')).toBeDefined();
    expect(result.loop.iterations[0].outcome).toBe('unresolved');
  });

  it('rejects when dirty worktree fails typecheck', async () => {
    const { events, bus } = collectEvents();
    const git = makeFakeGitPort({ headSha: 'sha-1', statusOutput: 'M file.ts' });
    let commitCalled = false;
    git.commit = async () => {
      commitCalled = true;
      return 'sha-2';
    };

    let typecheckCount = 0;
    const deps = makeDeps({
      events: bus,
      git,
      runImplement: async () => ({ invocationId: 'i1', agentOutcome: 'success' }),
      runTypecheck: async () => {
        typecheckCount++;
        // 1st: top-level gate (pass)
        // 2nd: uncommitted changes check (fail)
        return { outcome: typecheckCount === 1 ? 'pass' : 'fail', output: 'error' };
      },
      runSpecReview: async () => ({
        invocationId: 'sr1',
        agentOutcome: 'success',
        verdict: 'fail',
      }),
      runFix: async () => ({
        invocationId: 'f1',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
        headBeforeFix: 'sha-1',
      }),
    });

    const result = await new ImplementStepLoop(deps).execute(baseInput());
    expect(commitCalled).toBe(false);
    expect(events.find((e) => e.type === 'fix.auto_commit.failed')).toBeUndefined();
    expect(result.loop.iterations[0].outcome).toBe('unresolved');
  });
});

describe('dirty dimension tracking (#723)', () => {
  it('only runs spec-review when spec is dirty and quality is clean', async () => {
    let specCalls = 0;
    let qualityCalls = 0;
    const deps = makeDeps({
      runSpecReview: async () => {
        specCalls += 1;
        return {
          invocationId: `sr-${specCalls}`,
          agentOutcome: 'success',
          verdict: specCalls === 1 ? 'fail' : 'pass',
        };
      },
      runQualityReview: async () => {
        qualityCalls += 1;
        return { invocationId: `qr-${qualityCalls}`, agentOutcome: 'success', verdict: 'pass' };
      },
      runFix: async () => ({
        invocationId: 'fix-1',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
      }),
    });
    const result = await new ImplementStepLoop(deps).execute(baseInput());
    expect(result.outcome).toBe('success');
    expect(specCalls).toBe(2);
    expect(qualityCalls).toBe(1);
  });

  it('only runs quality-review when quality is dirty and spec is clean', async () => {
    let specCalls = 0;
    let qualityCalls = 0;
    const deps = makeDeps({
      runSpecReview: async () => {
        specCalls += 1;
        return { invocationId: `sr-${specCalls}`, agentOutcome: 'success', verdict: 'pass' };
      },
      runQualityReview: async () => {
        qualityCalls += 1;
        return { invocationId: `qr-${qualityCalls}`, agentOutcome: 'success', verdict: 'pass' };
      },
    });
    const result = await new ImplementStepLoop(deps).execute(baseInput());
    expect(result.outcome).toBe('success');
    expect(specCalls).toBe(1);
    expect(qualityCalls).toBe(1);
  });

  it('reopens dimension when final pair review fails', async () => {
    let specCalls = 0;
    let qualityCalls = 0;
    const deps = makeDeps({
      runSpecReview: async () => {
        specCalls += 1;
        return { invocationId: `sr-${specCalls}`, agentOutcome: 'success', verdict: 'pass' };
      },
      runQualityReview: async () => {
        qualityCalls += 1;
        return {
          invocationId: `qr-${qualityCalls}`,
          agentOutcome: 'success',
          verdict: qualityCalls === 1 ? 'fail' : 'pass',
        };
      },
      runFix: async () => ({
        invocationId: `fix-${qualityCalls}`,
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
      }),
    });
    const result = await new ImplementStepLoop(deps).execute(baseInput());
    expect(result.outcome).toBe('success');
    expect(qualityCalls).toBeGreaterThan(1);
  });

  it('transitions dirty dimension to recurred when it fails again after initial fail', async () => {
    let specCalls = 0;
    const deps = makeDeps({
      runSpecReview: async () => {
        specCalls += 1;
        return {
          invocationId: `sr-${specCalls}`,
          agentOutcome: 'success',
          verdict: specCalls === 1 ? 'fail' : 'pass',
        };
      },
      runQualityReview: async () => ({
        invocationId: 'qr-1',
        agentOutcome: 'success',
        verdict: 'pass',
      }),
      runFix: async () => ({
        invocationId: `fix-${specCalls}`,
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
      }),
    });
    const result = await new ImplementStepLoop(deps).execute(baseInput());
    expect(result.outcome).toBe('success');
    expect(specCalls).toBeGreaterThanOrEqual(2);
  });

  it('both dirty dimensions are invoked when both fail on initial pass', async () => {
    let specCalls = 0;
    let qualityCalls = 0;
    const deps = makeDeps({
      runSpecReview: async () => {
        specCalls += 1;
        return {
          invocationId: `sr-${specCalls}`,
          agentOutcome: 'success',
          verdict: specCalls < 4 ? 'fail' : 'pass',
        };
      },
      runQualityReview: async () => {
        qualityCalls += 1;
        return {
          invocationId: `qr-${qualityCalls}`,
          agentOutcome: 'success',
          verdict: qualityCalls < 2 ? 'fail' : 'pass',
        };
      },
      runFix: async () => ({
        invocationId: `fix-${specCalls + qualityCalls}`,
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
      }),
    });
    const result = await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 5 });
    expect(result.outcome).toBe('success');
    expect(specCalls).toBeGreaterThan(1);
    expect(qualityCalls).toBeGreaterThan(1);
  });

  it('reviewScopeOptions reflects dirty dimension state', async () => {
    let capturedSpecScope: import('../types.js').ReviewScopeOptions | undefined;
    let capturedQualityScope: import('../types.js').ReviewScopeOptions | undefined;
    const deps = makeDeps({
      runSpecReview: async (_ctx, _tc, scope) => {
        capturedSpecScope = scope;
        return { invocationId: 'sr-1', agentOutcome: 'success', verdict: 'pass' };
      },
      runQualityReview: async (_ctx, _tc, scope) => {
        capturedQualityScope = scope;
        return { invocationId: 'qr-1', agentOutcome: 'success', verdict: 'pass' };
      },
    });
    await new ImplementStepLoop(deps).execute(baseInput());
    expect(capturedSpecScope?.mode).toBe('initial_full');
    expect(capturedQualityScope?.mode).toBe('initial_full');
  });

  it('mismatched final pair snapshots cause continue rather than immediate return', async () => {
    const git = makeFakeGitPort({ headSha: 'sha-stable' });
    let iteration = 0;
    const deps = makeDeps({
      git,
      runSpecReview: async () => ({
        invocationId: `sr-${++iteration}`,
        agentOutcome: 'success',
        verdict: 'pass',
        snapshot: { snapshot: `spec-snapshot-${iteration}` },
      }),
      runQualityReview: async () => ({
        invocationId: `qr-${iteration}`,
        agentOutcome: 'success',
        verdict: 'pass',
        snapshot: { snapshot: `quality-snapshot-${iteration}` },
      }),
    });
    const result = await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 5 });
    expect(result.loop.iterations.length).toBeGreaterThan(1);
  });
});

describe('final pair tracking (#723)', () => {
  it('enters final pair when both dimensions pass and no dirty dimensions remain', async () => {
    const git = makeFakeGitPort({ headSha: 'sha-stable' });
    const deps = makeDeps({
      git,
      runSpecReview: async () => ({
        invocationId: 'sr-1',
        agentOutcome: 'success',
        verdict: 'pass',
        snapshot: { snapshot: 'spec-snapshot-1' },
      }),
      runQualityReview: async () => ({
        invocationId: 'qr-1',
        agentOutcome: 'success',
        verdict: 'pass',
        snapshot: { snapshot: 'quality-snapshot-1' },
      }),
    });
    const result = await new ImplementStepLoop(deps).execute(baseInput());
    expect(result.outcome).toBe('success');
    expect(result.loop.iterations.length).toBe(2);
  });

  it('exits final pair when HEAD changes before second review', async () => {
    const git = makeFakeGitPort({
      headSha: ['sha-stable', 'sha-changed'],
    });
    const deps = makeDeps({
      git,
      runSpecReview: async () => ({
        invocationId: 'sr-1',
        agentOutcome: 'success',
        verdict: 'pass',
        snapshot: { snapshot: 'spec-snapshot-1' },
      }),
      runQualityReview: async () => ({
        invocationId: 'qr-1',
        agentOutcome: 'success',
        verdict: 'pass',
        snapshot: { snapshot: 'quality-snapshot-1' },
      }),
    });
    const result = await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 10 });
    expect(result.outcome).toBe('success');
    expect(result.loop.iterations.length).toBeGreaterThan(1);
  });
});
