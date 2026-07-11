import { describe, it, expect, vi } from 'vitest';
import { RunId, PhaseName, AgentProfileName } from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import type { GitPort } from '../../ports/git-port.js';
import { FakeLoopRepository } from '../../test-doubles/fake-loop-repository.js';
import {
  FakeFindingEvidenceInspector,
  makeFindingEvidenceInspector,
} from '../../test-doubles/fake-finding-evidence-inspector.js';
import { FakeArtifactStore } from '../../test-doubles/fake-artifact-store.js';
import { ReviewFixLoop } from '../review-fix-loop.js';
import type {
  ReviewFixLoopDeps,
  ReviewStepResult,
  FixStepResult,
  RevalidationResult,
  FixStepOptions,
  StepContext,
  PostFixGateResult,
  ReviewStepOptions,
  ReviewLoopHistoryEntry,
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

function makeFakeGitPort(opts: {
  headSha: string;
  statusOutput?: string;
  headShaThrows?: boolean;
  statusThrows?: boolean;
}): GitPort {
  return {
    createWorktree: async () => undefined,
    removeWorktree: async () => undefined,
    currentBranch: async () => 'main',
    headCommitSha: async () => {
      if (opts.headShaThrows) throw new Error('rev-parse failed');
      return opts.headSha;
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
          verdict: reviewCalls < 3 ? ('fail' as const) : ('pass' as const),
        };
      },
    });
    const out = await new ReviewFixLoop(deps).execute(baseInput());
    expect(out.phaseOutcome).toBe('passed');
    expect(out.loop.iterations).toHaveLength(3);
    expect(out.loop.iterations[0]?.outcome).toBe('fixed');
    expect(out.loop.iterations[1]?.outcome).toBe('fixed');
    expect(out.loop.iterations[2]?.outcome).toBe('resolved');
    expect(reviewCalls).toBe(3);
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
    expect(out.loop.iterations).toHaveLength(4);
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
          verdict: reviewCalls < 3 ? ('fail' as const) : ('pass' as const),
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
    expect(out.phaseOutcome).toBe('passed');
    expect(out.loop.status).toBe('converged');
    expect(out.loop.iterations).toHaveLength(3);
    expect(out.loop.iterations[0]?.outcome).toBe('fixed');
    expect(out.loop.iterations[1]?.outcome).toBe('fixed');
    expect(out.loop.iterations[2]?.outcome).toBe('resolved');
    expect(reviewCalls).toBe(3);
    expect(fixCalls).toBe(2);
  });

  it('does not converge when review returns overridden pass (severity gate forces fail)', async () => {
    let reviewCalls = 0;
    const deps = makeDeps({
      runReview: async () => {
        reviewCalls += 1;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: reviewCalls < 3 ? ('fail' as const) : ('pass' as const),
          ...(reviewCalls < 3
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
    // Iteration 2: review verdict=overridden "fail" → fix → reval pass → fixed
    // Iteration 3: review verdict=pass (no override) → resolved
    expect(out.phaseOutcome).toBe('passed');
    expect(out.loop.status).toBe('converged');
    expect(out.loop.iterations).toHaveLength(3);
    expect(out.loop.iterations[0]?.outcome).toBe('fixed');
    expect(out.loop.iterations[1]?.outcome).toBe('fixed');
    expect(out.loop.iterations[2]?.outcome).toBe('resolved');
    expect(reviewCalls).toBe(3);
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
    expect(out.loop.iterations).toHaveLength(4);
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

    it('bypasses reviewer on red gate, calls fixer with deterministic diagnostic, and resumes review on pass', async () => {
      let reviewCalls = 0;
      let fixCalls = 0;
      const fixOptions: FixStepOptions[] = [];
      let gateCalls = 0;

      const deps = makeDeps({
        runPostFixGate: async (): Promise<PostFixGateResult> => {
          gateCalls += 1;
          // Fail on iteration 2, pass on iteration 3 (after deterministic fix)
          return {
            outcome: gateCalls === 1 ? 'fail' : 'pass',
            output: 'build error diagnostics',
          };
        },
        runReview: async () => {
          reviewCalls += 1;
          return {
            invocationId: `rev-${reviewCalls}`,
            agentOutcome: 'success' as const,
            verdict: reviewCalls === 1 ? 'fail' : 'pass',
          };
        },
        runFix: async (ctx, opts) => {
          fixCalls += 1;
          fixOptions.push(opts);
          return {
            invocationId: `fix-${fixCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'done_with_fixes',
          };
        },
      });

      const out = await new ReviewFixLoop(deps).execute({ ...baseInput(), maxIterations: 4 });
      expect(out.phaseOutcome).toBe('passed');
      // Iteration 1: Review Fail -> Fix (standard)
      // Iteration 2: Gate fails -> Bypasses reviewer, calls Fixer (deterministic)
      // Iteration 3: Gate passes -> Reviewer called (returns pass) -> Resolved!
      expect(reviewCalls).toBe(2); // Only called in Iteration 1 and 3, not 2
      expect(fixCalls).toBe(2);
      expect(fixOptions[0]!.attemptKind).toBeUndefined(); // Standard fix
      expect(fixOptions[1]!.attemptKind).toBe('deterministic'); // Deterministic fix
      expect(fixOptions[1]!.deterministicDiagnostic).toBe('build error diagnostics');
    });

    it('exhausts caps and unresolved when gate repeatedly fails', async () => {
      let fixCalls = 0;
      let gateCalls = 0;
      let reviewCalls = 0;

      const deps = makeDeps({
        runPostFixGate: async (): Promise<PostFixGateResult> => {
          gateCalls += 1;
          return { outcome: 'fail', output: 'persistent error' };
        },
        runReview: async () => {
          reviewCalls += 1;
          return {
            invocationId: `rev-${reviewCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'fail',
          };
        },
        runFix: async () => {
          fixCalls += 1;
          return {
            invocationId: `fix-${fixCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'done_with_fixes',
          };
        },
      });

      const out = await new ReviewFixLoop(deps).execute({
        ...baseInput(),
        maxIterations: 5,
        maxTotalFixAttempts: 2, // total fix attempts cap
      });

      expect(out.loopStatus).toBe('exhausted');
      expect(out.phaseOutcome).toBe('failed');
      expect(reviewCalls).toBe(1); // Reviewer only called once at iteration 1
      expect(fixCalls).toBe(2); // Initial fix (1) + deterministic fix (2) -> cap hit
      expect(gateCalls).toBe(2);
    });

    it('supports auto-commit fallback on deterministic bypass path when dirty worktree passes revalidation', async () => {
      const { bus } = collectEvents();
      const git = makeFakeGitPort({ headSha: 'sha-1', statusOutput: 'M file.ts' });
      let commitCalls = 0;
      let addAllCalled = false;
      git.addAll = async () => {
        addAllCalled = true;
      };
      git.commit = async (cwd, message) => {
        commitCalls += 1;
        if (commitCalls === 1) {
          expect(message).toContain('(auto-committed — agent left changes uncommitted)');
        } else {
          expect(message).toContain('fix: deterministic gate resolution (auto-committed)');
        }
        return 'sha-2';
      };

      let gateCalls = 0;
      let reviewCalls = 0;
      let fixCalls = 0;
      const deps = makeDeps({
        events: bus,
        git,
        runPostFixGate: async (): Promise<PostFixGateResult> => {
          gateCalls += 1;
          // Fail on iteration 2 to trigger deterministic fix path
          return {
            outcome: gateCalls === 1 ? 'fail' : 'pass',
            output: 'build error diagnostics',
          };
        },
        runReview: async () => {
          reviewCalls += 1;
          return {
            invocationId: `rev-${reviewCalls}`,
            agentOutcome: 'success' as const,
            verdict: reviewCalls === 1 ? 'fail' : 'pass',
            offendingFindings: [{ severity: 'high', summary: 'fix this' }],
          };
        },
        runFix: async () => {
          fixCalls += 1;
          return {
            invocationId: `fix-${fixCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'done_with_fixes',
            headBeforeFix: 'sha-1',
          };
        },
        runRevalidation: async () => ({ validationRunId: 'v1', passed: true }),
      });

      const out = await new ReviewFixLoop(deps).execute({ ...baseInput(), maxIterations: 4 });
      expect(out.phaseOutcome).toBe('passed');
      expect(addAllCalled).toBe(true);
      expect(commitCalls).toBe(2);
      expect(out.loop.iterations[0].outcome).toBe('fixed');
      expect(out.loop.iterations[1].outcome).toBe('fixed');
      expect(out.loop.iterations[1].kind).toBe('deterministic_fix');
    });
  });

  describe('loop history', () => {
    it('passes historyContext to reviewer and fixer calls', async () => {
      const history = [
        {
          iteration: 1,
          review: {
            verdict: 'fail' as const,
            offendingFindings: [{ severity: 'high', summary: 'missing guard' }],
          },
          fix: {
            verdict: 'done_with_fixes' as const,
            invocationId: 'fix-1',
            summary: 'Added guard',
          },
          revalidation: { passed: true, validationRunId: 'val-1' },
          outcome: 'fixed' as const,
        },
      ];
      const loopHistory = {
        read: vi.fn(async () => history),
        append: vi.fn(async () => {}),
        format: vi.fn((_entries, audience) => `history for ${audience}`),
      };

      const receivedReviewOpts: Array<ReviewStepOptions | undefined> = [];
      const receivedFixOpts: Array<FixStepOptions> = [];

      let reviewCalls = 0;
      const deps = makeDeps({
        loopHistory,
        runReview: async (_ctx, opts) => {
          reviewCalls += 1;
          receivedReviewOpts.push(opts);
          return {
            invocationId: `rev-${reviewCalls}`,
            agentOutcome: 'success' as const,
            verdict: reviewCalls === 1 ? ('fail' as const) : ('pass' as const),
          };
        },
        runFix: async (_ctx, opts) => {
          receivedFixOpts.push(opts);
          return {
            invocationId: 'fix-2',
            agentOutcome: 'success' as const,
            verdict: 'done_with_fixes' as const,
          };
        },
        runRevalidation: async () => ({
          validationRunId: 'val-2',
          passed: true,
        }),
      });

      const architectPlan = {
        version: 1,
        tasks: [
          {
            task_id: '1',
            approach: 'do it',
            conflicts_resolved: [],
            constraints: [],
            depends_on: [],
          },
        ],
      };

      const out = await new ReviewFixLoop(deps).execute({
        ...baseInput(),
        architectPlan,
      });

      expect(out.phaseOutcome).toBe('passed');
      expect(loopHistory.read).toHaveBeenCalled();
      expect(loopHistory.format).toHaveBeenCalledWith(history, 'reviewer');
      expect(loopHistory.format).toHaveBeenCalledWith(history, 'fixer');

      // Reviewer called twice: once in iteration 1 (fail) and once in iteration 2 (pass)
      expect(receivedReviewOpts).toHaveLength(2);
      expect(receivedReviewOpts[0]).toEqual({
        historyContext: 'history for reviewer',
      });
      expect(receivedReviewOpts[1]).toEqual({
        historyContext: 'history for reviewer',
        gateResult: { outcome: 'pass', output: '' },
      });

      // Fixer called once in iteration 1 (because review failed)
      expect(receivedFixOpts).toHaveLength(1);
      expect(receivedFixOpts[0]).toEqual({
        useFallback: false,
        architectPlan,
        historyContext: 'history for fixer',
      });
    });

    it('passes historyContext to fixer while retaining useFallback and previousInvocationId', async () => {
      const history = [
        {
          iteration: 1,
          review: {
            verdict: 'fail' as const,
            offendingFindings: [{ severity: 'high', summary: 'missing guard' }],
          },
          fix: {
            verdict: 'done_with_fixes' as const,
            invocationId: 'fix-1',
            summary: 'Added guard',
          },
          revalidation: { passed: true, validationRunId: 'val-1' },
          outcome: 'fixed' as const,
        },
      ];
      const loopHistory = {
        read: vi.fn(async () => history),
        append: vi.fn(async () => {}),
        format: vi.fn((_entries, audience) => `history for ${audience}`),
      };

      const receivedFixOpts: Array<FixStepOptions> = [];

      let reviewCalls = 0;
      let fixCalls = 0;
      const deps = makeDeps({
        loopHistory,
        runReview: async () => {
          reviewCalls += 1;
          return {
            invocationId: `rev-${reviewCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'fail' as const,
          };
        },
        runFix: async (_ctx, opts) => {
          fixCalls += 1;
          receivedFixOpts.push(opts);
          return {
            invocationId: `fix-call-${fixCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'cannot_fix' as const,
          };
        },
      });

      await new ReviewFixLoop(deps).execute({
        ...baseInput(),
        maxIterations: 3,
      });

      // Fixer called 3 times (iterations 1, 2, 3)
      expect(receivedFixOpts).toHaveLength(3);

      // Iteration 1: first fix call (consecutive failures = 0)
      expect(receivedFixOpts[0]).toEqual({
        useFallback: false,
        historyContext: 'history for fixer',
      });

      // Iteration 2: second fix call (consecutive failures = 1)
      expect(receivedFixOpts[1]).toEqual({
        useFallback: false,
        historyContext: 'history for fixer',
      });

      // Iteration 3: third fix call (consecutive failures = 2) -> useFallback is true
      expect(receivedFixOpts[2]).toEqual({
        useFallback: true,
        previousInvocationId: 'fix-call-2',
        historyContext: 'history for fixer',
      });
    });

    it('appends completed loop history entries for each loop outcome', async () => {
      // 1. resolved (review pass)
      const loopHistory1 = {
        read: vi.fn(async () => []),
        append: vi.fn(async () => {}),
        format: vi.fn(() => ''),
      };
      const deps1 = makeDeps({
        loopHistory: loopHistory1,
        runReview: async () => ({
          invocationId: 'rev-1',
          agentOutcome: 'success' as const,
          verdict: 'pass' as const,
        }),
      });
      await new ReviewFixLoop(deps1).execute(baseInput());
      expect(loopHistory1.append).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          iteration: 1,
          review: expect.objectContaining({ verdict: 'pass', invocationId: 'rev-1' }),
          outcome: 'resolved',
        }),
      );

      // 2. fixed (fix + revalidation pass)
      const loopHistory2 = {
        read: vi.fn(async () => []),
        append: vi.fn(async () => {}),
        format: vi.fn(() => ''),
      };
      let revCalls2 = 0;
      const deps2 = makeDeps({
        loopHistory: loopHistory2,
        runReview: async () => {
          revCalls2 += 1;
          return {
            invocationId: `rev-${revCalls2}`,
            agentOutcome: 'success' as const,
            verdict: revCalls2 === 1 ? ('fail' as const) : ('pass' as const),
          };
        },
        runFix: async () => ({
          invocationId: 'fix-1',
          agentOutcome: 'success' as const,
          verdict: 'done_with_fixes' as const,
        }),
        runRevalidation: async () => ({
          validationRunId: 'val-1',
          passed: true,
        }),
      });
      await new ReviewFixLoop(deps2).execute(baseInput());
      expect(loopHistory2.append).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          fix: expect.objectContaining({ verdict: 'done_with_fixes', invocationId: 'fix-1' }),
          revalidation: expect.objectContaining({ passed: true, validationRunId: 'val-1' }),
          outcome: 'fixed',
        }),
      );

      // 3. unresolved (fix failure or cannot_fix)
      const loopHistory3 = {
        read: vi.fn(async () => []),
        append: vi.fn(async () => {}),
        format: vi.fn(() => ''),
      };
      const deps3 = makeDeps({
        loopHistory: loopHistory3,
        runReview: async () => ({
          invocationId: 'rev-1',
          agentOutcome: 'success' as const,
          verdict: 'fail' as const,
        }),
        runFix: async () => ({
          invocationId: 'fix-1',
          agentOutcome: 'success' as const,
          verdict: 'cannot_fix' as const,
        }),
      });
      await new ReviewFixLoop(deps3).execute({
        ...baseInput(),
        maxIterations: 1,
      });
      expect(loopHistory3.append).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          outcome: 'unresolved',
        }),
      );

      // 4. failed (review agent fails)
      const loopHistory4 = {
        read: vi.fn(async () => []),
        append: vi.fn(async () => {}),
        format: vi.fn(() => ''),
      };
      const deps4 = makeDeps({
        loopHistory: loopHistory4,
        runReview: async () => ({
          invocationId: 'rev-fail',
          agentOutcome: 'failure' as const,
        }),
      });
      await new ReviewFixLoop(deps4).execute(baseInput());
      expect(loopHistory4.append).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          review: expect.objectContaining({ invocationId: 'rev-fail' }),
          outcome: 'failed',
        }),
      );
    });

    it('gracefully handles loopHistory.read failure before reviewer invocation', async () => {
      const { events, bus } = collectEvents();
      const loopHistory = {
        read: vi.fn(async () => {
          throw new Error('read error before reviewer');
        }),
        append: vi.fn(async () => {}),
        format: vi.fn(() => ''),
      };
      const deps = makeDeps({
        loopHistory,
        events: bus,
        runReview: async () => ({
          invocationId: 'rev-1',
          agentOutcome: 'success' as const,
          verdict: 'pass' as const,
        }),
      });
      const out = await new ReviewFixLoop(deps).execute(baseInput());
      expect(out.phaseOutcome).toBe('passed');
      expect(out.loop.status).toBe('converged');
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'review_loop_history.read_failed',
          metadata: expect.objectContaining({ iterationIndex: 1, audience: 'reviewer' }),
        }),
      );
    });

    it('gracefully handles loopHistory.read failure before fixer invocation', async () => {
      const { events, bus } = collectEvents();
      let readCount = 0;
      const loopHistory = {
        read: vi.fn(async () => {
          readCount++;
          if (readCount === 2) {
            throw new Error('read error before fixer');
          }
          return [];
        }),
        append: vi.fn(async () => {}),
        format: vi.fn(() => ''),
      };
      let revCalls = 0;
      const deps = makeDeps({
        loopHistory,
        events: bus,
        runReview: async () => {
          revCalls += 1;
          return {
            invocationId: `rev-${revCalls}`,
            agentOutcome: 'success' as const,
            verdict: revCalls === 1 ? ('fail' as const) : ('pass' as const),
          };
        },
        runFix: async () => ({
          invocationId: 'fix-1',
          agentOutcome: 'success' as const,
          verdict: 'done_with_fixes' as const,
        }),
        runRevalidation: async () => ({
          validationRunId: 'val-1',
          passed: true,
        }),
      });
      const out = await new ReviewFixLoop(deps).execute(baseInput());
      expect(out.phaseOutcome).toBe('passed');
      expect(out.loop.status).toBe('converged');
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'review_loop_history.read_failed',
          metadata: expect.objectContaining({ iterationIndex: 1, audience: 'fixer' }),
        }),
      );
    });

    it('gracefully handles loopHistory.append failure after a completed iteration', async () => {
      const { events, bus } = collectEvents();
      const loopHistory = {
        read: vi.fn(async () => []),
        append: vi.fn(async () => {
          throw new Error('append error');
        }),
        format: vi.fn(() => ''),
      };
      let revCalls = 0;
      const deps = makeDeps({
        loopHistory,
        events: bus,
        runReview: async () => {
          revCalls += 1;
          return {
            invocationId: `rev-${revCalls}`,
            agentOutcome: 'success' as const,
            verdict: revCalls === 1 ? ('fail' as const) : ('pass' as const),
          };
        },
        runFix: async () => ({
          invocationId: 'fix-1',
          agentOutcome: 'success' as const,
          verdict: 'done_with_fixes' as const,
        }),
        runRevalidation: async () => ({
          validationRunId: 'val-1',
          passed: true,
        }),
      });
      const out = await new ReviewFixLoop(deps).execute(baseInput());
      expect(out.phaseOutcome).toBe('passed');
      expect(out.loop.status).toBe('converged');
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'review_loop_history.append_failed',
          metadata: expect.objectContaining({ iterationIndex: 1, outcome: 'fixed' }),
        }),
      );
    });
  });

  describe('structural evidence check (issue #623)', () => {
    it('converges on iteration 2 when every finding is unfounded and fixer rebuts', async () => {
      const evidenceFake = new FakeFindingEvidenceInspector();
      evidenceFake.setNext({ evidenceConfirmed: false, reason: 'path missing' });
      const artifactStore = new FakeArtifactStore();
      await artifactStore.write({
        runId: 'run-1',
        relativePath: 'code-review.md',
        contents: 'Some review finding about `fix-diff-inspector.ts:10` here.',
      });
      let reviewCalls = 0;
      const deps = makeDeps({
        findingEvidenceInspector: makeFindingEvidenceInspector(evidenceFake),
        artifactStore,
        runReview: async () => {
          reviewCalls += 1;
          return {
            invocationId: `rev-${reviewCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'fail' as const,
            offendingFindings: [
              { severity: 'critical', summary: 'command injection in fix-diff-inspector.ts' },
            ],
          };
        },
        runFix: async () => ({
          invocationId: 'fix-1',
          agentOutcome: 'success' as const,
          verdict: 'done_no_fixes_needed' as const,
          rebuttal: 'The cited code does not exist.',
        }),
        runRevalidation: async () => ({ validationRunId: 'v-1', passed: true }),
      });
      const out = await new ReviewFixLoop(deps).execute(baseInput());
      // Iteration 1: review fail (1 finding, all unfounded) → fix (done_no_fixes_needed)
      //   → rebuttal-accepted → resolved → converged
      expect(out.phaseOutcome).toBe('passed');
      expect(out.loop.status).toBe('converged');
      expect(out.loop.iterations).toHaveLength(1);
      expect(out.loop.iterations[0]?.outcome).toBe('resolved');
      expect(evidenceFake.calls.length).toBeGreaterThanOrEqual(1);
    });

    it('falls through to existing fix path when at least one finding is grounded', async () => {
      const evidenceFake = new FakeFindingEvidenceInspector();
      // First finding: grounded (real evidence). Second: unfounded.
      evidenceFake.setResultFn((i) => {
        if (i.evidence.path === 'real.ts') {
          return { evidenceConfirmed: true, reason: 'ok' };
        }
        return { evidenceConfirmed: false, reason: 'path missing' };
      });
      const artifactStore = new FakeArtifactStore();
      await artifactStore.write({
        runId: 'run-1',
        relativePath: 'code-review.md',
        contents: 'Finding 1: `real.ts:12`\nFinding 2: `fake.ts:34`',
      });
      let reviewCalls = 0;
      const deps = makeDeps({
        findingEvidenceInspector: makeFindingEvidenceInspector(evidenceFake),
        artifactStore,
        runReview: async () => {
          reviewCalls += 1;
          return {
            invocationId: `rev-${reviewCalls}`,
            agentOutcome: 'success' as const,
            verdict: reviewCalls === 1 ? ('fail' as const) : ('pass' as const),
            offendingFindings: [
              { severity: 'high', summary: 'real issue in real.ts' },
              { severity: 'high', summary: 'fabricated in fake.ts' },
            ],
          };
        },
        runFix: async () => ({
          invocationId: 'fix-1',
          agentOutcome: 'success' as const,
          verdict: 'done_no_fixes_needed' as const,
          rebuttal: 'one finding is real',
        }),
        runRevalidation: async () => ({ validationRunId: 'v-1', passed: true }),
      });
      const out = await new ReviewFixLoop(deps).execute({ ...baseInput(), maxIterations: 2 });
      // Iteration 1: review fail (1 grounded + 1 unfounded) → fix done_with_fixes
      //   → reval pass → fixed. NOT a rebuttal convergence (because 1 grounded).
      expect(out.loop.iterations[0]?.outcome).toBe('fixed');
      // Iteration 2: review pass → resolved.
      expect(out.loop.iterations[1]?.outcome).toBe('resolved');
      expect(out.phaseOutcome).toBe('passed');
    });

    it('does not converge on rebuttal when no evidence inspector is wired', async () => {
      let reviewCalls = 0;
      const deps = makeDeps({
        // no findingEvidenceInspector
        runReview: async () => {
          reviewCalls += 1;
          return {
            invocationId: `rev-${reviewCalls}`,
            agentOutcome: 'success' as const,
            verdict: reviewCalls === 1 ? ('fail' as const) : ('pass' as const),
            offendingFindings: [{ severity: 'high', summary: 'fabricated finding' }],
          };
        },
        runFix: async () => ({
          invocationId: 'fix-1',
          agentOutcome: 'success' as const,
          verdict: 'done_no_fixes_needed' as const,
          rebuttal: 'no evidence check available',
        }),
        runRevalidation: async () => ({ validationRunId: 'v-1', passed: true }),
      });
      const out = await new ReviewFixLoop(deps).execute({ ...baseInput(), maxIterations: 3 });
      // No inspector → existing path → fix succeeds → reval passes → fixed (iter 1)
      // → review pass (iter 2) → resolved.
      expect(out.phaseOutcome).toBe('passed');
      expect(out.loop.iterations[0]?.outcome).toBe('fixed');
      expect(out.loop.iterations[1]?.outcome).toBe('resolved');
    });

    it('short-circuits to needs_human_review on unfounded_pingpong after 4 iterations', async () => {
      const evidenceFake = new FakeFindingEvidenceInspector();
      // First finding: grounded (real evidence). Second: unfounded.
      evidenceFake.setResultFn((i) => {
        if (i.evidence.path === 'real.ts') {
          return { evidenceConfirmed: true, reason: 'ok' };
        }
        return { evidenceConfirmed: false, reason: 'path missing' };
      });
      const artifactStore = new FakeArtifactStore();
      await artifactStore.write({
        runId: 'run-1',
        relativePath: 'code-review.md',
        contents: 'Finding 1: `real.ts:12`\nFinding 2: `fake.ts:34`',
      });
      let reviewCalls = 0;
      const deps = makeDeps({
        findingEvidenceInspector: makeFindingEvidenceInspector(evidenceFake),
        artifactStore,
        unfoundedPingPongLimit: 4,
        runReview: async () => {
          reviewCalls += 1;
          return {
            invocationId: `rev-${reviewCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'fail' as const,
            offendingFindings: [
              { severity: 'high', summary: 'real issue in real.ts' },
              { severity: 'high', summary: 'fabricated in fake.ts' },
            ],
          };
        },
        runFix: async () => ({
          invocationId: 'fix',
          agentOutcome: 'success' as const,
          verdict: 'done_no_fixes_needed' as const,
          rebuttal: 'the finding is fabricated',
        }),
        runRevalidation: async () => ({ validationRunId: 'v', passed: false }),
      });
      const out = await new ReviewFixLoop(deps).execute({ ...baseInput(), maxIterations: 10 });
      // After 4 consecutive iterations of (1 unfounded + done_no_fixes_needed),
      // short-circuit to needs_human_review (NOT exhausted).
      expect(out.phaseOutcome).toBe('failed');
      expect(out.needsHumanReview).toBe(true);
      expect(out.loop.status).not.toBe('exhausted');
      expect(out.loop.iterations.length).toBeLessThanOrEqual(10);
    });

    it('does not short-circuit when unfounded_pingpong detector sees done_with_fixes in the window', async () => {
      const evidenceFake = new FakeFindingEvidenceInspector();
      // First finding: grounded (real evidence). Second: unfounded.
      evidenceFake.setResultFn((i) => {
        if (i.evidence.path === 'real.ts') {
          return { evidenceConfirmed: true, reason: 'ok' };
        }
        return { evidenceConfirmed: false, reason: 'path missing' };
      });
      const artifactStore = new FakeArtifactStore();
      await artifactStore.write({
        runId: 'run-1',
        relativePath: 'code-review.md',
        contents: 'Finding 1: `real.ts:12`\nFinding 2: `fake.ts:34`',
      });
      let reviewCalls = 0;
      const deps = makeDeps({
        findingEvidenceInspector: makeFindingEvidenceInspector(evidenceFake),
        artifactStore,
        unfoundedPingPongLimit: 4,
        runReview: async () => {
          reviewCalls += 1;
          return {
            invocationId: `rev-${reviewCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'fail' as const,
            offendingFindings: [
              { severity: 'high', summary: 'real issue in real.ts' },
              { severity: 'high', summary: 'fabricated in fake.ts' },
            ],
          };
        },
        runFix: async () => {
          // Iteration 1: done_with_fixes (a real attempt). 2..5: done_no_fixes_needed.
          return {
            invocationId: 'fix',
            agentOutcome: 'success' as const,
            verdict:
              reviewCalls <= 1 ? ('done_with_fixes' as const) : ('done_no_fixes_needed' as const),
            ...(reviewCalls > 1 ? { rebuttal: 'still fabricated' } : {}),
          };
        },
        runRevalidation: async () => ({ validationRunId: 'v', passed: false }),
      });
      const out = await new ReviewFixLoop(deps).execute({ ...baseInput(), maxIterations: 6 });
      // Because iteration 1 had done_with_fixes, the 4-iteration window
      // (iter 2..5) is all done_no_fixes_needed → ping-pong fires → NHR.
      // Actually iter 2..5 is 4 entries → trigger.
      expect(out.needsHumanReview).toBe(true);
      expect(out.phaseOutcome).toBe('failed');
    });
  });

  describe('endOnReview (#627)', () => {
    it('grants one trailing post-fix re-review when the last iteration ended `fixed` and endOnReview=true (default)', async () => {
      let reviewCalls = 0;
      const deps = makeDeps({
        runReview: async () => {
          reviewCalls += 1;
          return {
            invocationId: `rev-${reviewCalls}`,
            agentOutcome: 'success' as const,
            verdict: reviewCalls < 3 ? ('fail' as const) : ('pass' as const),
          };
        },
      });
      const out = await new ReviewFixLoop(deps).execute({ ...baseInput(), maxIterations: 2 });
      // Iteration 1: review fail → fix → reval pass → fixed
      // Iteration 2: review fail → fix → reval pass → fixed
      // Trailing re-review (iteration 3): review pass → resolved
      expect(out.phaseOutcome).toBe('passed');
      expect(out.loop.status).toBe('converged');
      expect(out.loop.iterations).toHaveLength(3);
      expect(out.loop.iterations[0]?.outcome).toBe('fixed');
      expect(out.loop.iterations[1]?.outcome).toBe('fixed');
      expect(out.loop.iterations[2]?.outcome).toBe('resolved');
      expect(reviewCalls).toBe(3);
    });

    it('does not grant a trailing re-review when endOnReview=false', async () => {
      let reviewCalls = 0;
      const deps = makeDeps({
        options: { endOnReview: false },
        runReview: async () => {
          reviewCalls += 1;
          return {
            invocationId: `rev-${reviewCalls}`,
            agentOutcome: 'success' as const,
            verdict: reviewCalls < 3 ? ('fail' as const) : ('pass' as const),
          };
        },
      });
      const out = await new ReviewFixLoop(deps).execute({ ...baseInput(), maxIterations: 2 });
      // Iteration 1: review fail → fix → reval pass → fixed
      // Iteration 2: review fail → fix → reval pass → fixed (budget exhausted)
      expect(out.phaseOutcome).toBe('failed');
      expect(out.loop.status).toBe('exhausted');
      expect(out.loop.iterations).toHaveLength(2);
      expect(reviewCalls).toBe(2);
    });

    it('does not grant a trailing re-review when the last iteration ended `unresolved`', async () => {
      let reviewCalls = 0;
      const deps = makeDeps({
        runReview: async () => {
          reviewCalls += 1;
          return {
            invocationId: `rev-${reviewCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'fail' as const,
          };
        },
        runFix: async () => ({
          invocationId: 'fix-fail',
          agentOutcome: 'success' as const,
          verdict: 'cannot_fix' as const,
        }),
      });
      const out = await new ReviewFixLoop(deps).execute({ ...baseInput(), maxIterations: 2 });
      // Iterations 1 + 2: review fail → fix (cannot_fix) → unresolved each time
      // No trailing re-review (cannot_fix is not `fixed`)
      expect(out.phaseOutcome).toBe('failed');
      expect(out.loop.status).toBe('exhausted');
      expect(out.loop.iterations).toHaveLength(2);
      expect(reviewCalls).toBe(2);
    });
  });

  describe('deltaScopedReReview (#627)', () => {
    it('passes prevReviewedCommitSha to runReview on iteration >= 2 by default', async () => {
      const receivedOpts: Array<ReviewStepOptions | undefined> = [];
      const deps = makeDeps({
        runReview: async (_ctx, opts) => {
          receivedOpts.push(opts);
          return {
            invocationId: `rev-${receivedOpts.length}`,
            agentOutcome: 'success' as const,
            verdict: receivedOpts.length === 1 ? ('fail' as const) : ('pass' as const),
            reviewedCommitSha: `sha-${receivedOpts.length}`,
          };
        },
      });
      await new ReviewFixLoop(deps).execute(baseInput());
      // Iteration 1: no prev SHA (first review)
      expect(receivedOpts[0]?.prevReviewedCommitSha).toBeUndefined();
      // Iteration 2: prev SHA = sha-1 from iteration 1
      expect(receivedOpts[1]?.prevReviewedCommitSha).toBe('sha-1');
    });

    it('omits prevReviewedCommitSha when deltaScopedReReview=false', async () => {
      const receivedOpts: Array<ReviewStepOptions | undefined> = [];
      const deps = makeDeps({
        options: { deltaScopedReReview: false },
        runReview: async (_ctx, opts) => {
          receivedOpts.push(opts);
          return {
            invocationId: `rev-${receivedOpts.length}`,
            agentOutcome: 'success' as const,
            verdict: receivedOpts.length === 1 ? ('fail' as const) : ('pass' as const),
            reviewedCommitSha: `sha-${receivedOpts.length}`,
          };
        },
      });
      await new ReviewFixLoop(deps).execute(baseInput());
      expect(receivedOpts[0]?.prevReviewedCommitSha).toBeUndefined();
      expect(receivedOpts[1]?.prevReviewedCommitSha).toBeUndefined();
    });
  });

  describe('trend-aware exit (#627)', () => {
    function makeDepsWithHistory(over: Partial<ReviewFixLoopDeps>) {
      const historyStore: ReviewLoopHistoryEntry[] = [];
      return makeDeps({
        loopHistory: {
          read: async () => historyStore,
          append: async (_ctx, entry) => {
            historyStore.push(entry);
          },
          format: (_entries, audience) => `history for ${audience}`,
        },
        ...over,
      });
    }

    it('exits as converged_with_notes when severity-weighted counts trend down in strict mode', async () => {
      let reviewCall = 0;
      const findingsSequence: Array<Array<{ severity: string; summary: string }>> = [
        [
          { severity: 'high', summary: 'a' },
          { severity: 'high', summary: 'b' },
        ],
        [{ severity: 'high', summary: 'a' }],
        [{ severity: 'medium', summary: 'b' }],
      ];
      const deps = makeDepsWithHistory({
        runReview: async () => {
          const i = reviewCall++;
          return {
            invocationId: `rev-${i + 1}`,
            agentOutcome: 'success' as const,
            verdict: 'fail' as const,
            offendingFindings: findingsSequence[i] ?? [],
            reviewedCommitSha: `sha-${i + 1}`,
          };
        },
      });
      // maxIterations: 3 → 3 reviews run → trend detected at exhaustion.
      const out = await new ReviewFixLoop(deps).execute({ ...baseInput(), maxIterations: 3 });
      expect(out.phaseOutcome).toBe('passed');
      expect(out.loopStatus).toBe('converged_with_notes');
      expect(out.loop.status).toBe('converged_with_notes');
      expect(out.needsHumanReview).toBe(true);
    });

    it('does NOT exit as converged_with_notes when revalidation failed (strict mode)', async () => {
      let reviewCall = 0;
      const findingsSequence: Array<Array<{ severity: string; summary: string }>> = [
        [
          { severity: 'high', summary: 'a' },
          { severity: 'high', summary: 'b' },
        ],
        [{ severity: 'high', summary: 'a' }],
        [{ severity: 'medium', summary: 'b' }],
      ];
      const deps = makeDepsWithHistory({
        runRevalidation: async () => ({ validationRunId: 'v', passed: false, category: 'build' }),
        runReview: async () => {
          const i = reviewCall++;
          return {
            invocationId: `rev-${i + 1}`,
            agentOutcome: 'success' as const,
            verdict: 'fail' as const,
            offendingFindings: findingsSequence[i] ?? [],
            reviewedCommitSha: `sha-${i + 1}`,
          };
        },
      });
      const out = await new ReviewFixLoop(deps).execute({ ...baseInput(), maxIterations: 3 });
      expect(out.phaseOutcome).toBe('failed');
      expect(out.loopStatus).toBe('exhausted');
      expect(out.needsHumanReview).toBeUndefined();
    });

    it('does NOT exit as converged_with_notes when post-fix-gate failed on trailing re-review (strict mode)', async () => {
      let reviewCall = 0;
      const findingsSequence: Array<Array<{ severity: string; summary: string }>> = [
        [
          { severity: 'high', summary: 'a' },
          { severity: 'high', summary: 'b' },
        ],
        [{ severity: 'high', summary: 'a' }],
        [{ severity: 'medium', summary: 'b' }],
        [{ severity: 'medium', summary: 'b' }],
      ];
      const deps = makeDepsWithHistory({
        runPostFixGate: async (ctx) => {
          if (ctx.iterationIndex === 4) {
            return { outcome: 'fail', output: 'lint error' };
          }
          return { outcome: 'pass', output: '' };
        },
        runReview: async () => {
          const i = reviewCall++;
          return {
            invocationId: `rev-${i + 1}`,
            agentOutcome: 'success' as const,
            verdict: 'fail' as const,
            offendingFindings: findingsSequence[i] ?? [],
            reviewedCommitSha: `sha-${i + 1}`,
          };
        },
      });
      const out = await new ReviewFixLoop(deps).execute({ ...baseInput(), maxIterations: 3 });
      expect(out.phaseOutcome).toBe('failed');
      expect(out.loopStatus).toBe('exhausted');
      expect(out.needsHumanReview).toBeUndefined();
    });

    it('honors lenient mode and exits even when post-fix-gate failed on trailing re-review', async () => {
      let reviewCall = 0;
      const findingsSequence: Array<Array<{ severity: string; summary: string }>> = [
        [
          { severity: 'high', summary: 'a' },
          { severity: 'high', summary: 'b' },
        ],
        [{ severity: 'high', summary: 'a' }],
        [{ severity: 'medium', summary: 'b' }],
        [{ severity: 'medium', summary: 'b' }],
      ];
      const deps = makeDepsWithHistory({
        options: { trendAwareExit: { mode: 'lenient' } },
        runPostFixGate: async (ctx) => {
          if (ctx.iterationIndex === 4) {
            return { outcome: 'fail', output: 'lint error' };
          }
          return { outcome: 'pass', output: '' };
        },
        runReview: async () => {
          const i = reviewCall++;
          return {
            invocationId: `rev-${i + 1}`,
            agentOutcome: 'success' as const,
            verdict: 'fail' as const,
            offendingFindings: findingsSequence[i] ?? [],
            reviewedCommitSha: `sha-${i + 1}`,
          };
        },
      });
      const out = await new ReviewFixLoop(deps).execute({ ...baseInput(), maxIterations: 3 });
      expect(out.loopStatus).toBe('converged_with_notes');
      expect(out.loop.status).toBe('converged_with_notes');
      expect(out.needsHumanReview).toBe(true);
    });

    it('does not exit as converged_with_notes when trendAwareExit.enabled=false', async () => {
      let reviewCall = 0;
      const findingsSequence: Array<Array<{ severity: string; summary: string }>> = [
        [
          { severity: 'high', summary: 'a' },
          { severity: 'high', summary: 'b' },
        ],
        [{ severity: 'high', summary: 'a' }],
        [{ severity: 'medium', summary: 'b' }],
      ];
      const deps = makeDepsWithHistory({
        options: { trendAwareExit: { enabled: false } },
        runReview: async () => {
          const i = reviewCall++;
          return {
            invocationId: `rev-${i + 1}`,
            agentOutcome: 'success' as const,
            verdict: 'fail' as const,
            offendingFindings: findingsSequence[i] ?? [],
            reviewedCommitSha: `sha-${i + 1}`,
          };
        },
      });
      const out = await new ReviewFixLoop(deps).execute({ ...baseInput(), maxIterations: 3 });
      expect(out.loopStatus).toBe('exhausted');
      expect(out.phaseOutcome).toBe('failed');
    });
  });
});

describe('ReviewFixLoop fix-commit verifier integration', () => {
  it('treats done_with_fixes as fixed when HEAD advanced (no downgrade events)', async () => {
    const preSha = 'sha-pre';
    const postSha = 'sha-post';
    const { events, bus } = collectEvents();
    const git = makeFakeGitPort({ headSha: postSha, statusOutput: '' });
    const deps = makeDeps({
      events: bus,
      git,
      runReview: async (): Promise<ReviewStepResult> => ({
        invocationId: 'r1',
        agentOutcome: 'success' as const,
        verdict: 'fail' as const,
      }),
      runFix: async (): Promise<FixStepResult> => ({
        invocationId: 'f1',
        agentOutcome: 'success' as const,
        verdict: 'done_with_fixes' as const,
        headBeforeFix: preSha,
      }),
    });
    const out = await new ReviewFixLoop(deps).execute({ ...baseInput(), maxIterations: 3 });
    expect(out.loop.iterations.some((it) => it.outcome === 'fixed')).toBe(true);
    expect(events.find((e) => e.type === 'fix.uncommitted_changes')).toBeUndefined();
    expect(events.find((e) => e.type === 'fix.no_commit_claimed')).toBeUndefined();
  });

  it('downgrades done_with_fixes + dirty tree to unresolved with fix.uncommitted_changes; calls runRevalidation and auto-commits', async () => {
    const revalidationCalls: number[] = [];
    const { events, bus } = collectEvents();
    const git = makeFakeGitPort({
      headSha: 'sha-pre',
      statusOutput: ' M packages/foo.ts\n',
    });
    let addAllCalled = false;
    git.addAll = async () => {
      addAllCalled = true;
    };
    const deps = makeDeps({
      events: bus,
      git,
      runRevalidation: async () => {
        revalidationCalls.push(Date.now());
        return { validationRunId: 'v', passed: true };
      },
      runReview: async (): Promise<ReviewStepResult> => ({
        invocationId: 'r1',
        agentOutcome: 'success' as const,
        verdict: 'fail' as const,
      }),
      runFix: async (): Promise<FixStepResult> => ({
        invocationId: 'f1',
        agentOutcome: 'success' as const,
        verdict: 'done_with_fixes' as const,
        headBeforeFix: 'sha-pre',
      }),
    });
    await new ReviewFixLoop(deps).execute({ ...baseInput(), maxIterations: 3 });
    expect(addAllCalled).toBe(true);
    expect(events.find((e) => e.type === 'fix.uncommitted_changes')).toBeDefined();
    expect(events.find((e) => e.type === 'fix.auto_commit.succeeded')).toBeDefined();
    expect(revalidationCalls.length).toBeGreaterThan(0);
  });

  it('downgrades done_with_fixes + clean tree to unresolved with fix.no_commit_claimed', async () => {
    const { events, bus } = collectEvents();
    const git = makeFakeGitPort({ headSha: 'sha-pre', statusOutput: '' });
    const deps = makeDeps({
      events: bus,
      git,
      runReview: async (): Promise<ReviewStepResult> => ({
        invocationId: 'r1',
        agentOutcome: 'success' as const,
        verdict: 'fail' as const,
      }),
      runFix: async (): Promise<FixStepResult> => ({
        invocationId: 'f1',
        agentOutcome: 'success' as const,
        verdict: 'done_with_fixes' as const,
        headBeforeFix: 'sha-pre',
      }),
    });
    await new ReviewFixLoop(deps).execute({ ...baseInput(), maxIterations: 3 });
    const ev = events.find((e) => e.type === 'fix.no_commit_claimed');
    expect(ev).toBeDefined();
  });
});

describe('ReviewFixLoop auto-commit fallback', () => {
  const baseInput = () => ({
    runId: RunId('run-1'),
    phaseId: PhaseName('phase-1'),
    repoId: 'repo-1',
    cwd: '/wt',
    maxIterations: 2,
  });

  it('auto-commits when dirty worktree passes revalidation', async () => {
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
      runReview: async () => ({
        invocationId: 'r1',
        agentOutcome: 'success',
        verdict: 'fail',
        offendingFindings: [{ severity: 'high', summary: 'fix this' }],
      }),
      runFix: async () => ({
        invocationId: 'f1',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
        headBeforeFix: 'sha-1',
      }),
      runRevalidation: async () => ({ validationRunId: 'v1', passed: true }),
    });

    const result = await new ReviewFixLoop(deps).execute(baseInput());
    expect(addAllCalled).toBe(true);
    expect(commitCalled).toBe(true);
    expect(events.find((e) => e.type === 'fix.auto_commit.succeeded')).toBeDefined();
    // Iteration 1 should be 'fixed'
    expect(result.loop.iterations[0].outcome).toBe('fixed');
  });

  it('rejects when dirty worktree fails revalidation', async () => {
    const { events, bus } = collectEvents();
    const git = makeFakeGitPort({ headSha: 'sha-1', statusOutput: 'M file.ts' });
    let commitCalled = false;
    git.commit = async () => {
      commitCalled = true;
      return 'sha-2';
    };

    const deps = makeDeps({
      events: bus,
      git,
      runReview: async () => ({
        invocationId: 'r1',
        agentOutcome: 'success',
        verdict: 'fail',
        offendingFindings: [{ severity: 'high', summary: 'fix this' }],
      }),
      runFix: async () => ({
        invocationId: 'f1',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
        headBeforeFix: 'sha-1',
      }),
      runRevalidation: async () => ({ validationRunId: 'v1', passed: false }),
    });

    const result = await new ReviewFixLoop(deps).execute(baseInput());
    expect(commitCalled).toBe(false);
    expect(events.find((e) => e.type === 'fix.auto_commit.failed')).toBeUndefined();
    expect(result.loop.iterations[0].outcome).toBe('unresolved');
  });

  it('retries once on git lock error and succeeds', async () => {
    const { events, bus } = collectEvents();
    const git = makeFakeGitPort({ headSha: 'sha-1', statusOutput: 'M file.ts' });
    let attempts = 0;
    git.addAll = async () => {};
    git.commit = async () => {
      attempts++;
      // Reset attempts between iterations because the loop will retry the whole thing
      // until it exhausts maxIterations or succeeds.
      // Iteration 1 auto-commit succeeds on 2nd attempt -> fixed.
      // Iteration 2 starts...
      if (attempts === 1) throw new Error('Unable to create .git/index.lock');
      return 'sha-2';
    };

    const deps = makeDeps({
      events: bus,
      git,
      runReview: async () => ({
        invocationId: 'r1',
        agentOutcome: 'success',
        verdict: 'fail',
        offendingFindings: [{ severity: 'high', summary: 'fix this' }],
      }),
      runFix: async () => ({
        invocationId: 'f1',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
        headBeforeFix: 'sha-1',
      }),
      runRevalidation: async () => ({ validationRunId: 'v1', passed: true }),
    });

    await new ReviewFixLoop(deps).execute({ ...baseInput(), maxIterations: 1 });
    expect(attempts).toBe(2);
    expect(events.find((e) => e.type === 'fix.auto_commit.retry')).toBeDefined();
    expect(events.find((e) => e.type === 'fix.auto_commit.succeeded')).toBeDefined();
  });

  it('retries once on git lock error and fails if still locked', async () => {
    const { events, bus } = collectEvents();
    const git = makeFakeGitPort({ headSha: 'sha-1', statusOutput: 'M file.ts' });
    let attempts = 0;
    git.addAll = async () => {};
    git.commit = async () => {
      attempts++;
      throw new Error('Unable to create .git/index.lock');
    };

    const deps = makeDeps({
      events: bus,
      git,
      runReview: async () => ({
        invocationId: 'r1',
        agentOutcome: 'success',
        verdict: 'fail',
        offendingFindings: [{ severity: 'high', summary: 'fix this' }],
      }),
      runFix: async () => ({
        invocationId: 'f1',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
        headBeforeFix: 'sha-1',
      }),
      runRevalidation: async () => ({ validationRunId: 'v1', passed: true }),
    });

    await new ReviewFixLoop(deps).execute({ ...baseInput(), maxIterations: 1 });
    expect(attempts).toBe(2);
    expect(events.find((e) => e.type === 'fix.auto_commit.retry')).toBeDefined();
    expect(events.find((e) => e.type === 'fix.auto_commit.failed')).toBeDefined();
  });
});
