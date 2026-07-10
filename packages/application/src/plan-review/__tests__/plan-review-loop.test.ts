import { describe, it, expect } from 'vitest';
import { RunId, PhaseName } from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { FakeLoopRepository } from '../../test-doubles/fake-loop-repository.js';
import { PlanReviewLoop } from '../plan-review-loop.js';
import type {
  PlanReviewLoopDeps,
  PlanReviewResult,
  PlanFixResult,
  PlanReviewContext,
  PlanFixOptions,
  PlanReviewStepOptions,
} from '../types.js';
import type { ArbiterResult } from '../../implement-step/types.js';
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
    phaseId: PhaseName('plan-review'),
    repoId: 'owner/repo',
    cwd: '/wt',
    maxIterations: 3,
  };
}

function groundedP1Findings(citation = 'plan.md:42'): ReadonlyArray<PlanReviewFinding> {
  return [
    {
      severity: 'P1' as const,
      citation,
      failureScenario: 'Missing transition handler',
      evidence: 'grounded' as const,
    },
  ];
}

function makeDeps(over: Partial<PlanReviewLoopDeps>): {
  deps: PlanReviewLoopDeps;
  events: ReturnType<typeof collectEvents>['events'];
} {
  let n = 0;
  const { bus, events } = collectEvents();
  const deps: PlanReviewLoopDeps = {
    runReview: async (_ctx: PlanReviewContext): Promise<PlanReviewResult> => ({
      invocationId: `rev-${++n}`,
      agentOutcome: 'success' as const,
      verdict: 'pass' as const,
    }),
    runFix: async (_ctx: PlanReviewContext, _opts: PlanFixOptions): Promise<PlanFixResult> => ({
      invocationId: `fix-${++n}`,
      agentOutcome: 'success' as const,
      verdict: 'done_with_fixes' as const,
    }),
    checkManifestSync: async (_ctx: PlanReviewContext): Promise<string | null> => null,
    computeLastFixDiffCitations: (_cwd: string, _headBeforeFix: string | undefined) => [],
    runArbiter: undefined,
    loops: new FakeLoopRepository(),
    events: bus,
    now: () => new Date('2026-07-08T00:00:00.000Z'),
    idFactory: () => 'loop-1',
    ...over,
  };
  return { deps, events };
}

describe('PlanReviewLoop', () => {
  it('AC #5.1 — pass on first review', async () => {
    const { deps } = makeDeps({});
    const out = await new PlanReviewLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('success');
    expect(out.loop.status).toBe('converged');
    expect(out.loop.iterations).toHaveLength(1);
    expect(out.loop.iterations[0]?.outcome).toBe('resolved');
    expect(out.proceedWithConcerns).toBe(false);
  });

  it('delta-scoped re-review normalizes missing findings to an empty set', async () => {
    const { deps, events } = makeDeps({
      runReview: async (): Promise<PlanReviewResult> => ({
        invocationId: 'rev-1',
        agentOutcome: 'success' as const,
        verdict: 'p1_found' as const,
      }),
    });
    const out = await new PlanReviewLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('success');
    expect(out.loop.status).toBe('converged');
    expect(out.loop.iterations).toHaveLength(1);
    expect(out.loop.iterations[0]?.outcome).toBe('resolved');
    expect(events.some((e) => e.type === 'plan-review.review.evidence.gate_applied')).toBe(true);
  });

  it('AC #5.2 — fix then pass', async () => {
    let reviewCalls = 0;
    const { deps } = makeDeps({
      runReview: async (): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: reviewCalls === 1 ? ('p1_found' as const) : ('pass' as const),
          findings: reviewCalls === 1 ? groundedP1Findings() : [],
        };
      },
      runFix: async (): Promise<PlanFixResult> => ({
        invocationId: 'fix-1',
        agentOutcome: 'success' as const,
        verdict: 'done_with_fixes' as const,
      }),
    });
    const out = await new PlanReviewLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('success');
    expect(out.loop.iterations).toHaveLength(2);
    expect(out.loop.iterations[0]?.outcome).toBe('fixed');
    expect(out.loop.iterations[1]?.outcome).toBe('resolved');
  });

  it('AC #5.3 — contradiction → arbiter → finding_invalid', async () => {
    let reviewCalls = 0;
    const { deps } = makeDeps({
      runReview: async (): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: 'p1_found' as const,
          findings: groundedP1Findings(),
        };
      },
      runFix: async (): Promise<PlanFixResult> => ({
        invocationId: 'fix-1',
        agentOutcome: 'success' as const,
        verdict: 'done_no_fixes_needed' as const,
      }),
      runArbiter: async (): Promise<ArbiterResult> => ({
        outcome: 'finding_invalid',
        evidence: 'reviewer is wrong; the plan is sound',
        rationale: 'the cited defect is not present in plan.md',
      }),
    });
    const out = await new PlanReviewLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('success');
    expect(out.loop.iterations).toHaveLength(1);
    expect(out.loop.iterations[0]?.outcome).toBe('resolved');
  });

  it('AC #5.4 — contradiction → arbiter → finding_valid → eventually passes', async () => {
    let reviewCalls = 0;
    let fixCalls = 0;
    const { deps } = makeDeps({
      runReview: async (): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: reviewCalls === 2 ? ('pass' as const) : ('p1_found' as const),
          findings: reviewCalls === 2 ? [] : groundedP1Findings(),
        };
      },
      runFix: async (_ctx: PlanReviewContext, opts: PlanFixOptions): Promise<PlanFixResult> => {
        fixCalls += 1;
        return {
          invocationId: `fix-${fixCalls}`,
          agentOutcome: 'success' as const,
          // Iteration 1: contradiction (done_no_fixes_needed + p1_found) → arbiter
          // Iteration 2: finder acknowledges the carried-forward defect → done_with_fixes
          verdict:
            fixCalls === 1 ? ('done_no_fixes_needed' as const) : ('done_with_fixes' as const),
          ...(opts.reconciliationContext ? { rebuttal: 'reconciling' } : {}),
        };
      },
      runArbiter: async (): Promise<ArbiterResult> => ({
        outcome: 'finding_valid',
        evidence: 'defect is real',
        rationale: 'reviewer is correct: state-machine edge case unhandled',
      }),
    });
    const out = await new PlanReviewLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('success');
    expect(out.loop.iterations.length).toBeGreaterThanOrEqual(2);
  });

  it('AC #5.5 — exhaustion → needs_human_review', async () => {
    const { deps } = makeDeps({
      maxIterations: 2,
      runReview: async (): Promise<PlanReviewResult> => ({
        invocationId: 'rev-x',
        agentOutcome: 'success' as const,
        verdict: 'p1_found' as const,
        findings: groundedP1Findings(),
      }),
      runFix: async (): Promise<PlanFixResult> => ({
        invocationId: 'fix-x',
        agentOutcome: 'success' as const,
        verdict: 'done_with_fixes' as const,
      }),
    });
    const baseInputWithMax2 = { ...baseInput(), maxIterations: 2 };
    const out = await new PlanReviewLoop(deps).execute(baseInputWithMax2);
    expect(out.outcome).toBe('needs_human_review');
    expect(out.loop.status).toBe('exhausted');
    expect(out.loop.iterations.length).toBeGreaterThanOrEqual(2);
  });

  it('final fixer pass resolves P1 findings on the last allowed iteration', async () => {
    let reviewCalls = 0;
    let fixCalls = 0;
    const reviewOptions: Array<PlanReviewStepOptions | undefined> = [];
    const { deps } = makeDeps({
      runReview: async (
        _ctx: PlanReviewContext,
        opts?: PlanReviewStepOptions,
      ): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        reviewOptions.push(opts);
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: reviewCalls === 3 ? ('pass' as const) : ('p1_found' as const),
          findings:
            reviewCalls === 3
              ? []
              : [
                  {
                    severity: 'P1' as const,
                    citation: 'plan.md:42',
                    failureScenario: 'Missing transition handler',
                    evidence: 'grounded' as const,
                  },
                ],
        };
      },
      runFix: async (): Promise<PlanFixResult> => {
        fixCalls += 1;
        return {
          invocationId: `fix-${fixCalls}`,
          agentOutcome: 'success' as const,
          verdict: 'done_with_fixes' as const,
          headBeforeFix: fixCalls === 1 ? 'fix-head-1' : 'fix-head-2',
        };
      },
      computeLastFixDiffCitations: (_cwd, headBeforeFix) =>
        headBeforeFix === 'fix-head-1'
          ? ['plan.md:42']
          : headBeforeFix === 'fix-head-2'
            ? ['plan.md:50-55']
            : [],
    });
    const baseInputWithMax2 = { ...baseInput(), maxIterations: 2 };
    const out = await new PlanReviewLoop(deps).execute(baseInputWithMax2);
    expect(out.outcome).toBe('success');
    expect(out.loop.status).toBe('converged');
    expect(out.loop.iterations).toHaveLength(3);
    expect(out.loop.iterations[0]?.outcome).toBe('fixed');
    expect(out.loop.iterations[1]?.outcome).toBe('fixed');
    expect(out.loop.iterations[2]?.outcome).toBe('resolved');
    expect(reviewOptions[0]).toBeUndefined();
    expect(reviewOptions[1]).toMatchObject({
      prevFindings: [
        {
          severity: 'P1',
          citation: 'plan.md:42',
          failureScenario: 'Missing transition handler',
          evidence: 'grounded',
        },
      ],
      recentFixCitations: ['plan.md:42'],
    });
    // The trailing final review is a fresh full-plan review, NOT a
    // delta-scoped re-review (#716, design §4 Assumption 9) — its job is
    // to catch anything missed by the iterative loop. So `runReview` is
    // called with `undefined` opts, NOT `buildReviewStepOptions()`.
    expect(reviewOptions[2]).toBeUndefined();
  });

  it('refreshes recentFixCitations from computeLastFixDiffCitations even when headBeforeFix is undefined', async () => {
    let reviewCalls = 0;
    const computeCalls: Array<string | undefined> = [];
    const reviewOptions: Array<PlanReviewStepOptions | undefined> = [];
    const { deps } = makeDeps({
      runReview: async (
        _ctx: PlanReviewContext,
        opts?: PlanReviewStepOptions,
      ): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        reviewOptions.push(opts);
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: reviewCalls === 2 ? ('pass' as const) : ('p1_found' as const),
          findings: reviewCalls === 2 ? [] : groundedP1Findings(),
        };
      },
      runFix: async (): Promise<PlanFixResult> => ({
        invocationId: 'fix-1',
        agentOutcome: 'success' as const,
        verdict: 'done_with_fixes' as const,
      }),
      computeLastFixDiffCitations: (cwd, headBeforeFix) => {
        computeCalls.push(`${cwd}:${headBeforeFix ?? 'undefined'}`);
        return [];
      },
    });

    const out = await new PlanReviewLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('success');
    expect(computeCalls).toEqual(['/wt:undefined']);
    expect(reviewOptions[1]).toMatchObject({
      prevFindings: [
        {
          severity: 'P1',
          citation: 'plan.md:42',
          failureScenario: 'Missing transition handler',
          evidence: 'grounded',
          disposition: 'still_open',
        },
      ],
    });
  });

  it('passes explicit empty recentFixCitations on delta-scoped re-review when the fix diff is empty', async () => {
    let reviewCalls = 0;
    const reviewOptions: Array<PlanReviewStepOptions | undefined> = [];
    const { deps } = makeDeps({
      runReview: async (
        _ctx: PlanReviewContext,
        opts?: PlanReviewStepOptions,
      ): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        reviewOptions.push(opts);
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: reviewCalls === 2 ? ('pass' as const) : ('p1_found' as const),
          findings:
            reviewCalls === 2
              ? []
              : [
                  {
                    severity: 'P1' as const,
                    citation: 'plan.md:42',
                    failureScenario: 'Missing transition handler',
                    evidence: 'grounded' as const,
                  },
                ],
        };
      },
      runFix: async (): Promise<PlanFixResult> => ({
        invocationId: 'fix-1',
        agentOutcome: 'success' as const,
        verdict: 'done_with_fixes' as const,
      }),
      computeLastFixDiffCitations: () => [],
    });

    const out = await new PlanReviewLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('success');
    expect(reviewOptions[1]).toMatchObject({
      prevFindings: [
        {
          severity: 'P1',
          citation: 'plan.md:42',
          failureScenario: 'Missing transition handler',
          evidence: 'grounded',
          disposition: 'still_open',
        },
      ],
      recentFixCitations: [],
    });
  });

  it('AC #683.3.a — trailing final review fail + arbiter finding_invalid → success', async () => {
    let reviewCalls = 0;
    let arbiterCalls = 0;
    const { deps, events } = makeDeps({
      runReview: async (): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: 'p1_found' as const,
          findings: groundedP1Findings(),
        };
      },
      runFix: async (): Promise<PlanFixResult> => ({
        invocationId: 'fix-y',
        agentOutcome: 'success' as const,
        verdict: 'done_with_fixes' as const,
      }),
      runFinalReviewArbiter: async (): Promise<ArbiterResult> => {
        arbiterCalls += 1;
        return {
          outcome: 'finding_invalid',
          evidence: 'plan section 3 already covers this',
          rationale: 'the trailing finding misreads the plan',
        };
      },
    });
    const baseInputWithMax2 = { ...baseInput(), maxIterations: 2 };
    const out = await new PlanReviewLoop(deps).execute(baseInputWithMax2);
    expect(out.outcome).toBe('success');
    expect(out.loop.status).toBe('converged');
    expect(arbiterCalls).toBe(1);
    expect(out.loop.iterations).toHaveLength(3);
    expect(out.loop.iterations[2]?.outcome).toBe('resolved');
    expect(events.map((e) => e.type)).toContain('plan-review.final_review.arbiter.escalated');
    expect(events.map((e) => e.type)).toContain('plan-review.final_review.arbiter.resolved');
    const resolvedEvent = events.find(
      (e) => e.type === 'plan-review.final_review.arbiter.resolved',
    );
    expect(resolvedEvent?.metadata).toMatchObject({
      resolvedBy: 'final-review-arbiter',
    });
    const completedEvent = events.filter(
      (e) => e.type === 'plan-review.loop.iteration.completed',
    )[2];
    expect(completedEvent?.metadata).toMatchObject({
      outcome: 'resolved',
      resolvedBy: 'final-review-arbiter',
    });
  });

  it('AC #683.3.b — trailing final review fail + arbiter finding_valid → needs_human_review', async () => {
    let reviewCalls = 0;
    let arbiterCalls = 0;
    const { deps, events } = makeDeps({
      runReview: async (): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: 'p1_found' as const,
          findings: groundedP1Findings(),
        };
      },
      runFix: async (): Promise<PlanFixResult> => ({
        invocationId: 'fix-y',
        agentOutcome: 'success' as const,
        verdict: 'done_with_fixes' as const,
      }),
      runFinalReviewArbiter: async (): Promise<ArbiterResult> => {
        arbiterCalls += 1;
        return {
          outcome: 'finding_valid',
          evidence: 'defect is real and not addressed by prior fixes',
          rationale: 'the trailing reviewer identified a genuine gap',
        };
      },
      options: { bonusIteration: false },
    });
    const baseInputWithMax2 = { ...baseInput(), maxIterations: 2 };
    const out = await new PlanReviewLoop(deps).execute(baseInputWithMax2);
    expect(out.outcome).toBe('needs_human_review');
    expect(out.loop.status).toBe('exhausted');
    expect(arbiterCalls).toBe(1);
    expect(out.loop.iterations).toHaveLength(3);
    expect(out.loop.iterations[2]?.outcome).toBe('unresolved');
    expect(events.map((e) => e.type)).toContain('plan-review.final_review.arbiter.escalated');
    expect(events.map((e) => e.type)).toContain('plan-review.final_review.arbiter.resolved');
  });

  it('AC #683.3.c — trailing final review fail + no runFinalReviewArbiter configured → needs_human_review (regression)', async () => {
    let reviewCalls = 0;
    const { deps, events } = makeDeps({
      runReview: async (): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: 'p1_found' as const,
          findings: groundedP1Findings(),
        };
      },
      runFix: async (): Promise<PlanFixResult> => ({
        invocationId: 'fix-y',
        agentOutcome: 'success' as const,
        verdict: 'done_with_fixes' as const,
      }),
    });
    const baseInputWithMax2 = { ...baseInput(), maxIterations: 2 };
    const out = await new PlanReviewLoop(deps).execute(baseInputWithMax2);
    expect(out.outcome).toBe('needs_human_review');
    expect(out.loop.status).toBe('exhausted');
    expect(out.loop.iterations).toHaveLength(3);
    expect(out.loop.iterations[2]?.outcome).toBe('unresolved');
    expect(events.map((e) => e.type)).not.toContain('plan-review.final_review.arbiter.escalated');
  });

  it('trailing final review fail + arbiter finding_valid → needs_human_review', async () => {
    let reviewCalls = 0;
    let arbiterCalls = 0;
    const { deps } = makeDeps({
      runReview: async (): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: 'p1_found' as const,
          findings: groundedP1Findings(),
        };
      },
      runFix: async (): Promise<PlanFixResult> => ({
        invocationId: 'fix-y',
        agentOutcome: 'success' as const,
        verdict: 'done_with_fixes' as const,
      }),
      runFinalReviewArbiter: async (): Promise<ArbiterResult> => {
        arbiterCalls += 1;
        return {
          outcome: 'finding_valid',
          evidence: 'plan section 5 is missing the migration step',
          rationale: 'the trailing finding is correct',
        };
      },
      options: { bonusIteration: false },
    });
    const baseInputWithMax2 = { ...baseInput(), maxIterations: 2 };
    const out = await new PlanReviewLoop(deps).execute(baseInputWithMax2);
    expect(out.outcome).toBe('needs_human_review');
    expect(out.loop.status).toBe('exhausted');
    expect(arbiterCalls).toBe(1);
    expect(out.loop.iterations).toHaveLength(3);
    expect(out.loop.iterations[2]?.outcome).toBe('unresolved');
  });

  it('trailing final review fail + arbiter returns empty evidence → needs_human_review (G1 guardrail)', async () => {
    let reviewCalls = 0;
    let arbiterCalls = 0;
    const { deps, events } = makeDeps({
      runReview: async (): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: 'p1_found' as const,
          findings: groundedP1Findings(),
        };
      },
      runFix: async (): Promise<PlanFixResult> => ({
        invocationId: 'fix-y',
        agentOutcome: 'success' as const,
        verdict: 'done_with_fixes' as const,
      }),
      runFinalReviewArbiter: async (): Promise<ArbiterResult> => {
        arbiterCalls += 1;
        return {
          outcome: 'insufficient_evidence',
          evidence: '   ',
          rationale: 'artifacts unreadable',
        };
      },
    });
    const baseInputWithMax2 = { ...baseInput(), maxIterations: 2 };
    const out = await new PlanReviewLoop(deps).execute(baseInputWithMax2);
    expect(out.outcome).toBe('needs_human_review');
    expect(out.loop.status).toBe('exhausted');
    expect(arbiterCalls).toBe(1);
    expect(out.loop.iterations).toHaveLength(3);
    expect(out.loop.iterations[2]?.outcome).toBe('failed');
    const completedEvents = events.filter((e) => e.type === 'plan-review.loop.iteration.completed');
    expect(completedEvents).toHaveLength(3);
    expect(completedEvents[2]?.metadata).toMatchObject({
      index: 3,
      outcome: 'failed',
    });
  });

  it('bonus iteration — trailing arbiter finding_valid triggers bonus fix → succeeds', async () => {
    let reviewCalls = 0;
    let fixCalls = 0;
    let arbiterCalls = 0;
    const reviewOptions: Array<PlanReviewStepOptions | undefined> = [];
    const { deps, events } = makeDeps({
      runReview: async (
        _ctx: PlanReviewContext,
        opts?: PlanReviewStepOptions,
      ): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        reviewOptions.push(opts);
        // Iterations 1, 2: fail
        // Iteration 3 (trailing): fail
        // Iteration 4 (bonus final): pass
        // Every non-pass review call returns at least one grounded P1
        // finding. The evidence-bound gate (#716) downgrades a `p1_found`
        // verdict to `p2_only` when the reviewer returns no eligible
        // (grounded) findings; the test fixture must keep at least one
        // grounded P1 in scope so the verdict stays `p1_found`.
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: reviewCalls === 4 ? ('pass' as const) : ('p1_found' as const),
          findings:
            reviewCalls === 4
              ? []
              : [
                  {
                    severity: 'P1' as const,
                    citation: 'plan.md:42',
                    failureScenario: 'Missing transition handler',
                    evidence: 'grounded' as const,
                  },
                ],
        };
      },
      runFix: async (): Promise<PlanFixResult> => {
        fixCalls += 1;
        return {
          invocationId: `fix-${fixCalls}`,
          agentOutcome: 'success' as const,
          verdict: 'done_with_fixes' as const,
          headBeforeFix: fixCalls === 3 ? 'bonus-fix-head' : `fix-head-${fixCalls}`,
        };
      },
      computeLastFixDiffCitations: (_cwd, headBeforeFix) =>
        headBeforeFix === 'bonus-fix-head'
          ? ['plan.md:99-101']
          : headBeforeFix === 'fix-head-1'
            ? ['plan.md:42']
            : headBeforeFix === 'fix-head-2'
              ? ['plan.md:50-55']
              : [],
      runFinalReviewArbiter: async (): Promise<ArbiterResult> => {
        arbiterCalls += 1;
        return {
          outcome: 'finding_valid',
          evidence: 'P0 confirmed',
          rationale: 'fix the worker-ID scoping bug',
        };
      },
    });

    const out = await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 2 });
    expect(out.outcome).toBe('success');
    expect(out.loop.iterations).toHaveLength(4);
    expect(arbiterCalls).toBe(1);
    expect(fixCalls).toBe(3); // 2 original + 1 bonus
    expect(reviewCalls).toBe(4); // 2 original + 1 trailing + 1 bonus-trailing
    expect(reviewOptions[0]).toBeUndefined();
    expect(reviewOptions[3]).toMatchObject({
      prevFindings: [
        {
          severity: 'P1',
          citation: 'plan.md:42',
          failureScenario: 'Missing transition handler',
          evidence: 'grounded',
        },
      ],
      recentFixCitations: ['plan.md:99-101'],
    });

    expect(events.map((e) => e.type)).toContain(
      'plan-review.loop.trailing_review.bonus_fix_iteration',
    );
  });

  it('bonus iteration — capped at one (escalates to human if bonus fix does not converge)', async () => {
    let reviewCalls = 0;
    const { deps } = makeDeps({
      runReview: async (): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: 'p1_found' as const,
          findings: groundedP1Findings(),
        };
      },
      runFix: async (): Promise<PlanFixResult> => ({
        invocationId: 'fix-x',
        agentOutcome: 'success' as const,
        verdict: 'done_with_fixes' as const,
      }),
      runFinalReviewArbiter: async (): Promise<ArbiterResult> => ({
        outcome: 'finding_valid',
        evidence: 'real defect',
        rationale: 'still broken',
      }),
    });

    const out = await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 2 });
    expect(out.outcome).toBe('needs_human_review');
    expect(out.loop.iterations).toHaveLength(4); // 2 original + 1 trailing + 1 bonus-trailing
    expect(reviewCalls).toBe(4);
  });

  it('bonus iteration — can be disabled via options', async () => {
    let arbiterCalls = 0;
    const { deps } = makeDeps({
      runReview: async (): Promise<PlanReviewResult> => ({
        invocationId: 'rev-x',
        agentOutcome: 'success' as const,
        verdict: 'p1_found' as const,
        findings: groundedP1Findings(),
      }),
      runFix: async (): Promise<PlanFixResult> => ({
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

    const out = await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 2 });
    expect(out.outcome).toBe('needs_human_review');
    expect(out.loop.iterations).toHaveLength(3);
    expect(arbiterCalls).toBe(1);
  });

  it('parity #297 — reviewer retries on agent failure then converges', async () => {
    let reviewCalls = 0;
    const { deps } = makeDeps({
      runReview: async (): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: reviewCalls < 3 ? ('failed' as const) : ('success' as const),
          verdict: reviewCalls === 3 ? ('pass' as const) : undefined,
        };
      },
      reviewerMaxRetries: 2,
    });
    const out = await new PlanReviewLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('success');
    expect(reviewCalls).toBe(3);
    expect(out.loop.iterations).toHaveLength(1);
  });

  it('checkManifestSync in sync on every call → resolves on first pass, no fix call', async () => {
    let checkCalls = 0;
    let fixCalls = 0;
    const { deps } = makeDeps({
      checkManifestSync: async () => {
        checkCalls += 1;
        return null;
      },
      runFix: async (): Promise<PlanFixResult> => {
        fixCalls += 1;
        return {
          invocationId: 'fix-should-not-run',
          agentOutcome: 'success' as const,
          verdict: 'done_with_fixes' as const,
        };
      },
    });
    const out = await new PlanReviewLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('success');
    expect(out.loop.iterations).toHaveLength(1);
    expect(checkCalls).toBe(1);
    expect(fixCalls).toBe(0);
  });

  it('checkManifestSync reports drift on iteration 1 (reviewer passes), fixer resolves it, converges on iteration 2', async () => {
    let checkCalls = 0;
    let fixManifestMismatchSeen: string | undefined;
    const { deps } = makeDeps({
      runReview: async (): Promise<PlanReviewResult> => ({
        invocationId: 'rev-1',
        agentOutcome: 'success' as const,
        verdict: 'pass' as const,
      }),
      checkManifestSync: async () => {
        checkCalls += 1;
        return checkCalls === 1
          ? 'manifest tasks missing from plan.md prose: Task 4, Task 5, Task 6'
          : null;
      },
      runFix: async (_ctx, opts): Promise<PlanFixResult> => {
        fixManifestMismatchSeen = opts.manifestMismatch;
        return {
          invocationId: 'fix-1',
          agentOutcome: 'success' as const,
          verdict: 'done_with_fixes' as const,
        };
      },
    });
    const out = await new PlanReviewLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('success');
    expect(out.loop.iterations).toHaveLength(2);
    expect(out.loop.iterations[0]?.outcome).toBe('fixed');
    expect(out.loop.iterations[1]?.outcome).toBe('resolved');
    expect(fixManifestMismatchSeen).toBe(
      'manifest tasks missing from plan.md prose: Task 4, Task 5, Task 6',
    );
    expect(checkCalls).toBe(2);
  });

  it('manifest mismatch surfaces only in the trailing final-review pass → exhausts to needs_human_review', async () => {
    let reviewCalls = 0;
    const { deps } = makeDeps({
      runReview: async (): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: reviewCalls <= 3 ? ('p1_found' as const) : ('pass' as const),
          findings: reviewCalls <= 3 ? groundedP1Findings() : [],
        };
      },
      checkManifestSync: async (ctx: PlanReviewContext) =>
        ctx.iterationIndex === 4 ? 'manifest tasks missing from plan.md prose: Task 4' : null,
      runFix: async (): Promise<PlanFixResult> => ({
        invocationId: 'fix-x',
        agentOutcome: 'success' as const,
        verdict: 'done_with_fixes' as const,
      }),
    });
    const out = await new PlanReviewLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('needs_human_review');
    expect(out.loop.status).toBe('exhausted');
    // maxIterations (3) fixer iterations + 1 trailing final-review pass, all unresolved.
    expect(out.loop.iterations).toHaveLength(4);
    expect(out.loop.iterations[3]?.outcome).toBe('unresolved');
  });

  it('checkManifestSync reports drift on every iteration → loop exhausts → needs_human_review', async () => {
    const { deps } = makeDeps({
      checkManifestSync: async () => 'manifest tasks missing from plan.md prose: Task 2',
      runFix: async (): Promise<PlanFixResult> => ({
        invocationId: 'fix-x',
        agentOutcome: 'success' as const,
        verdict: 'done_with_fixes' as const,
      }),
    });
    const out = await new PlanReviewLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('needs_human_review');
    expect(out.loop.status).toBe('exhausted');
    expect(out.loop.iterations).toHaveLength(4);
    expect(
      out.loop.iterations.every((it) => it.outcome === 'fixed' || it.outcome === 'unresolved'),
    ).toBe(true);
  });

  it('fixer done_no_fixes_needed on a manifest-only mismatch is unresolved, not a review/fix contradiction', async () => {
    let reviewCalls = 0;
    const { deps, events } = makeDeps({
      runReview: async (): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: reviewCalls === 1 ? ('pass' as const) : ('pass' as const),
        };
      },
      checkManifestSync: async (ctx: PlanReviewContext) =>
        ctx.iterationIndex === 1 ? 'manifest tasks missing from plan.md prose: Task 3' : null,
      runFix: async (): Promise<PlanFixResult> => ({
        invocationId: 'fix-1',
        agentOutcome: 'success' as const,
        verdict: 'done_no_fixes_needed' as const,
        rebuttal: 'the manifest is intentionally out of date',
      }),
    });
    const out = await new PlanReviewLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('success');
    expect(out.loop.iterations[0]?.outcome).toBe('unresolved');
    expect(out.loop.iterations[1]?.outcome).toBe('resolved');
    expect(events.some((e) => e.type === 'plan-review.review.contradiction.detected')).toBe(false);
    expect(events.some((e) => e.type === 'plan-review.manifest_mismatch.fixer_declined')).toBe(
      true,
    );
  });

  it('dual failure: reviewer fails AND manifest check fails, fixer returns done_no_fixes_needed, arbiter is invoked but resolves to unresolved', async () => {
    let checkCalls = 0;
    let arbiterCalls = 0;
    const { deps } = makeDeps({
      runReview: async (): Promise<PlanReviewResult> => ({
        invocationId: 'rev-1',
        agentOutcome: 'success' as const,
        verdict: 'p1_found' as const,
        findings: groundedP1Findings(),
      }),
      checkManifestSync: async () => {
        checkCalls += 1;
        return 'manifest tasks missing';
      },
      runFix: async (): Promise<PlanFixResult> => ({
        invocationId: 'fix-1',
        agentOutcome: 'success' as const,
        verdict: 'done_no_fixes_needed' as const,
      }),
      runArbiter: async (): Promise<ArbiterResult> => {
        arbiterCalls += 1;
        return {
          invocationId: 'arb-1',
          agentOutcome: 'success' as const,
          outcome: 'finding_invalid' as const,
          evidence: 'ruling evidence',
          rationale: 'some rationale',
        };
      },
    });
    const out = await new PlanReviewLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('needs_human_review');
    expect(arbiterCalls).toBeGreaterThan(0);
    expect(checkCalls).toBeGreaterThan(0);
    expect(out.loop.iterations[0]?.outcome).toBe('unresolved');
  });
});

describe('PlanReviewLoop deltaScopedReReview (#716)', () => {
  // Helper: stub runReview that records the opts argument on each call.
  function makeRecordingRunReview(
    verdictSequence: Array<'pass' | 'p1_found' | 'p2_only'>,
    findingsSequence: Array<ReadonlyArray<import('../types.js').PlanReviewFinding>> = [],
  ) {
    const calls: Array<{
      ctx: import('../types.js').PlanReviewContext;
      opts?: import('../types.js').PlanReviewStepOptions;
    }> = [];
    let i = 0;
    const runReview = async (
      ctx: import('../types.js').PlanReviewContext,
      opts?: import('../types.js').PlanReviewStepOptions,
    ): Promise<import('../types.js').PlanReviewResult> => {
      calls.push({ ctx, opts });
      const verdict = verdictSequence[i] ?? 'pass';
      const findings = findingsSequence[i] ?? [];
      i += 1;
      return {
        invocationId: `rev-${i}`,
        agentOutcome: 'success' as const,
        verdict,
        findings,
      };
    };
    return { runReview, calls };
  }

  it('AC #1 — iteration 2 passes prevFindings and their current dispositions to runReview', async () => {
    const { runReview, calls } = makeRecordingRunReview(
      ['p1_found', 'pass'],
      [
        [
          {
            severity: 'P1',
            citation: 'plan.md:42',
            failureScenario: 'defect A',
            evidence: 'grounded',
          },
        ],
        [],
      ],
    );
    const { deps } = makeDeps({ runReview });
    const out = await new PlanReviewLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('success');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.opts?.prevFindings).toEqual([
      {
        severity: 'P1',
        citation: 'plan.md:42',
        failureScenario: 'defect A',
        evidence: 'grounded',
        disposition: 'still_open',
      },
    ]);
  });

  it('AC #1 negative — options.deltaScopedReReview=false omits prevFindings', async () => {
    const { runReview, calls } = makeRecordingRunReview(['p1_found', 'pass']);
    const { deps } = makeDeps({
      runReview,
      options: { deltaScopedReReview: false },
    });
    const out = await new PlanReviewLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('success');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.opts).toBeUndefined();
  });

  it('AC #2 regression — out-of-scope finding dropped from verdict computation', async () => {
    // Iter 1: returns a frozen finding (P1 at plan.md:42).
    // Iter 2: returns a NEW finding about pre-existing prose (plan.md:99)
    //         that the fix did NOT touch — must be dropped.
    const { runReview } = makeRecordingRunReview(
      ['p1_found', 'p2_only'],
      [
        [
          {
            severity: 'P1',
            citation: 'plan.md:42',
            failureScenario: 'defect A',
            evidence: 'grounded',
          },
        ],
        [
          {
            severity: 'P1',
            citation: 'plan.md:99',
            failureScenario: 'unrelated defect',
            evidence: 'grounded',
          },
        ],
      ],
    );
    // lastFixDiffCitations defaults to [] when computeLastFixDiffCitations
    // returns [] (no headBeforeFix). Every iter-2 finding outside the frozen
    // set is out of scope (the safe default per reviewer finding #1).
    const { deps } = makeDeps({ runReview });
    const out = await new PlanReviewLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('success');
    expect(out.loop.iterations).toHaveLength(2);
    expect(out.loop.iterations[1]?.outcome).toBe('resolved');
  });

  it('AC #2 positive control — finding targeting recent-fix citation is eligible', async () => {
    // Stub runReview to return a frozen finding on iter 1 and a finding on
    // iter 2 whose citation is in the recent-fix citation list — supplied
    // by computeLastFixDiffCitations returning ['plan.md:42'].
    const { runReview, calls } = makeRecordingRunReview(
      ['p1_found', 'p2_only'],
      [
        [
          {
            severity: 'P1',
            citation: 'plan.md:42',
            failureScenario: 'defect A',
            evidence: 'grounded',
          },
        ],
        [
          {
            severity: 'P1',
            citation: 'plan.md:42',
            failureScenario: 'defect A still open',
            evidence: 'grounded',
          },
        ],
      ],
    );
    const { deps } = makeDeps({
      runReview,
      computeLastFixDiffCitations: () => ['plan.md:42'],
    });
    const out = await new PlanReviewLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('success');
    expect(calls[1]?.opts?.prevFindings).toBeDefined();
    // The frozen finding is re-flagged with the same citation → eligible.
    expect(out.loop.status).toBe('converged');
  });

  it('AC #3 — ungrounded P1 cannot produce p1_found (downgrades to p2_only)', async () => {
    const { runReview } = makeRecordingRunReview(
      ['p1_found', 'pass'],
      [
        [
          {
            severity: 'P1',
            citation: '',
            failureScenario: 'no citation',
            evidence: 'ungrounded',
          },
        ],
        [],
      ],
    );
    const { deps } = makeDeps({ runReview });
    const out = await new PlanReviewLoop(deps).execute(baseInput());
    // Iter 1: reviewer says p1_found, but no grounded P0/P1 → downgrade to
    // p2_only → resolve (no fix needed).
    expect(out.outcome).toBe('success');
    expect(out.loop.iterations).toHaveLength(1);
    expect(out.loop.iterations[0]?.outcome).toBe('resolved');
  });

  it('AC #4 — finding-set is frozen at iteration 1', async () => {
    const frozen = [
      {
        severity: 'P1' as const,
        citation: 'plan.md:42',
        failureScenario: 'defect A',
        evidence: 'grounded' as const,
      },
    ];
    const { runReview, calls } = makeRecordingRunReview(
      ['p1_found', 'pass'],
      [
        frozen,
        [
          {
            severity: 'P2',
            citation: 'plan.md:42',
            failureScenario: 'defect A — now P2',
            evidence: 'grounded' as const,
          },
        ],
      ],
    );
    const { deps } = makeDeps({ runReview });
    const out = await new PlanReviewLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('success');
    // The frozen finding list passed on iteration 2 must equal the iter-1
    // finding list (frozen at the end of iter 1).
    expect(calls[1]?.opts?.prevFindings).toEqual(
      frozen.map((f) => ({ ...f, disposition: 'still_open' })),
    );
  });
});
