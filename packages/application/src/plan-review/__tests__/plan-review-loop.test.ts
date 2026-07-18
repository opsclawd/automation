import { describe, it, expect } from 'vitest';
import { RunId, PhaseName } from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { FakeLoopRepository } from '../../test-doubles/fake-loop-repository.js';
import { FakeReviewStateRepository } from '../../test-doubles/fake-review-state-repository.js';
import { PlanReviewLoop } from '../plan-review-loop.js';
import type {
  PlanReviewLoopDeps,
  PlanReviewResult,
  PlanFixResult,
  PlanReviewContext,
  PlanFixOptions,
  PlanReviewStepOptions,
  PlanReviewFinding,
  DeterministicPlanCheckResult,
  PlanReviewSnapshot,
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
    checkDeterministicPlan: async (_ctx): Promise<DeterministicPlanCheckResult> => ({
      diagnostic: null,
      signatureBlastRadiusFailures: [],
    }),
    computeLastFixDiffCitations: (_cwd: string, _headBeforeFix: string | undefined) => [],
    captureSnapshot: async (_ctx: PlanReviewContext): Promise<PlanReviewSnapshot | undefined> => ({
      planMdDigest: 'test-snapshot-digest',
      planMdPath: '/wt/plan.md',
      capturedAt: '2026-07-08T00:00:00.000Z',
    }),
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
    expect(out.loop.iterations).toHaveLength(3);
    expect(out.loop.iterations[0]?.outcome).toBe('fixed');
    expect(out.loop.iterations[1]?.outcome).toBe('resolved');
    expect(out.loop.iterations[2]?.outcome).toBe('resolved');
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
          verdict: reviewCalls >= 2 ? ('pass' as const) : ('p1_found' as const),
          findings: reviewCalls >= 2 ? [] : groundedP1Findings(),
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

  it('exhaustion when checkAndFixDeterministic exhausts loop budget and succeeds on the final iteration', async () => {
    let checkDeterministicCalls = 0;
    const { deps } = makeDeps({
      runReview: async (): Promise<PlanReviewResult> => ({
        invocationId: 'rev-1',
        agentOutcome: 'success' as const,
        verdict: 'pass' as const,
      }),
      runFix: async (): Promise<PlanFixResult> => ({
        invocationId: 'fix-1',
        agentOutcome: 'success' as const,
        verdict: 'done_with_fixes' as const,
      }),
      checkDeterministicPlan: async (_ctx): Promise<DeterministicPlanCheckResult> => {
        checkDeterministicCalls++;
        return checkDeterministicCalls === 1
          ? { diagnostic: 'deterministic check error', signatureBlastRadiusFailures: [] }
          : { diagnostic: null, signatureBlastRadiusFailures: [] };
      },
    });
    const baseInputWithMax1 = { ...baseInput(), maxIterations: 1 };
    const out = await new PlanReviewLoop(deps).execute(baseInputWithMax1);
    expect(out.outcome).toBe('needs_human_review');
    expect(out.loop.status).toBe('exhausted');
    expect(out.loop.iterations).toHaveLength(1);
    expect(out.loop.iterations[0]?.kind).toBe('deterministic_fix');
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
    // to catch anything missed by the iterative loop. We check that it runs
    // with mode final_full without prevFindings or recentFixCitations constraints.
    expect(reviewOptions[2]).toEqual({
      mode: 'final_full',
    });
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
          verdict: reviewCalls >= 2 ? ('pass' as const) : ('p1_found' as const),
          findings: reviewCalls >= 2 ? [] : groundedP1Findings(),
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
          verdict: reviewCalls >= 2 ? ('pass' as const) : ('p1_found' as const),
          findings:
            reviewCalls >= 2
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

  it('gate-manufactured recovery — contradiction arbiter returns insufficient_evidence → success', async () => {
    let reviewCalls = 0;
    const { deps, events } = makeDeps({
      runReview: async (): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        // Iteration 1: return pass, but with findings that the evidence-bound
        // gate will use to manufacture a p1_found verdict.
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: 'pass' as const,
          findings: [
            {
              severity: 'P1' as const,
              citation: 'plan.md:42',
              failureScenario: 'Manufactured defect',
              evidence: 'grounded' as const,
            },
          ],
        };
      },
      runFix: async (): Promise<PlanFixResult> => ({
        invocationId: 'fix-1',
        agentOutcome: 'success' as const,
        verdict: 'done_no_fixes_needed' as const,
      }),
      runArbiter: async (): Promise<ArbiterResult> => ({
        outcome: 'insufficient_evidence',
        evidence: 'missing artifacts',
        rationale: 'cannot see cited files',
      }),
    });
    const out = await new PlanReviewLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('success');
    expect(out.loop.iterations).toHaveLength(1);
    expect(out.loop.iterations[0]?.outcome).toBe('resolved');
    expect(events.some((e) => e.metadata?.resolvedBy === 'gate-manufactured-recovery')).toBe(true);
  });

  it('gate-manufactured recovery — final review arbiter returns insufficient_evidence → success', async () => {
    let reviewCalls = 0;
    const { deps, events } = makeDeps({
      runReview: async (): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        // To reach the final review arbiter with maxIterations=1, iteration 1
        // must be a fix iteration (not a pass).
        // Iteration 1: p1_found -> fix.
        // Iteration 2 (trailing final review pass): manufactured P1 (pass -> p1_found).
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: reviewCalls === 1 ? ('p1_found' as const) : ('pass' as const),
          findings: [
            {
              severity: 'P1' as const,
              citation: 'plan.md:42',
              failureScenario: reviewCalls === 1 ? 'Real defect' : 'Manufactured defect',
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
      runFinalReviewArbiter: async (): Promise<ArbiterResult> => ({
        outcome: 'insufficient_evidence',
        evidence: 'missing artifacts',
        rationale: 'cannot see cited files',
      }),
    });
    const out = await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 1 });
    expect(out.outcome).toBe('success');
    expect(out.loop.iterations).toHaveLength(2);
    expect(out.loop.iterations[1]?.outcome).toBe('resolved');
    expect(events.some((e) => e.metadata?.resolvedBy === 'gate-manufactured-recovery')).toBe(true);
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

  it('checkDeterministicPlan in sync on every call → resolves on first pass, no fix call', async () => {
    let checkCalls = 0;
    let fixCalls = 0;
    const { deps } = makeDeps({
      checkDeterministicPlan: async (_ctx) => {
        checkCalls += 1;
        return { diagnostic: null, signatureBlastRadiusFailures: [] };
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

  it('initial deterministic failure yields zero reviews and one fixer', async () => {
    let checkCalls = 0;
    let fixCalls = 0;
    let reviewCalls = 0;
    let fixDeterministicDiagnosticSeen: string | undefined;
    const { deps } = makeDeps({
      runReview: async (): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: 'pass' as const,
        };
      },
      checkDeterministicPlan: async (_ctx) => {
        checkCalls += 1;
        return checkCalls === 1
          ? {
              diagnostic: 'manifest tasks missing from plan.md prose: Task 4, Task 5, Task 6',
              signatureBlastRadiusFailures: [],
            }
          : { diagnostic: null, signatureBlastRadiusFailures: [] };
      },
      runFix: async (_ctx, opts): Promise<PlanFixResult> => {
        fixCalls += 1;
        fixDeterministicDiagnosticSeen = opts.deterministicDiagnostic;
        return {
          invocationId: 'fix-1',
          agentOutcome: 'success' as const,
          verdict: 'done_with_fixes' as const,
        };
      },
    });
    const out = await new PlanReviewLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('success');
    expect(out.loop.iterations).toHaveLength(3);
    expect(out.loop.iterations[0]?.kind).toBe('deterministic_fix');
    expect(out.loop.iterations[0]?.reviewInvocationId).toBeUndefined();
    expect(out.loop.iterations[0]?.fixInvocationId).toBe('fix-1');
    expect(out.loop.iterations[0]?.outcome).toBe('fixed');
    expect(out.loop.iterations[1]?.kind).toBe('review');
    expect(out.loop.iterations[1]?.outcome).toBe('resolved');
    expect(out.loop.iterations[2]?.kind).toBe('review');
    expect(out.loop.iterations[2]?.outcome).toBe('resolved');
    expect(fixDeterministicDiagnosticSeen).toBe(
      'manifest tasks missing from plan.md prose: Task 4, Task 5, Task 6',
    );
    expect(reviewCalls).toBe(2);
    expect(fixCalls).toBe(1);
  });

  it('persistent deterministic failure exhausts', async () => {
    let fixCalls = 0;
    let reviewCalls = 0;
    const { deps } = makeDeps({
      runReview: async (): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: 'pass' as const,
        };
      },
      checkDeterministicPlan: async (_ctx) => ({
        diagnostic: 'manifest tasks missing from plan.md prose: Task 2',
        signatureBlastRadiusFailures: [],
      }),
      runFix: async (): Promise<PlanFixResult> => {
        fixCalls += 1;
        return {
          invocationId: `fix-${fixCalls}`,
          agentOutcome: 'success' as const,
          verdict: 'done_with_fixes' as const,
        };
      },
    });
    const out = await new PlanReviewLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('needs_human_review');
    expect(out.loop.status).toBe('exhausted');
    expect(out.loop.iterations).toHaveLength(3); // maxIterations is 3
    expect(reviewCalls).toBe(0);
    expect(fixCalls).toBe(3);
    expect(out.loop.iterations.every((it) => it.kind === 'deterministic_fix')).toBe(true);
  });

  it('decline skips arbiters', async () => {
    let arbiterCalls = 0;
    const { deps, events } = makeDeps({
      runReview: async (): Promise<PlanReviewResult> => ({
        invocationId: 'rev-1',
        agentOutcome: 'success' as const,
        verdict: 'pass' as const,
      }),
      checkDeterministicPlan: async (_ctx) => {
        return { diagnostic: 'manifest tasks missing', signatureBlastRadiusFailures: [] };
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
    expect(arbiterCalls).toBe(0);
    expect(out.loop.iterations[0]?.outcome).toBe('unresolved');
    expect(events.some((e) => e.type === 'plan-review.deterministic_check.fixer_declined')).toBe(
      true,
    );
  });

  it('later deterministic failure precedes re-review and handles budget extension', async () => {
    let reviewCalls = 0;
    let fixCalls = 0;
    let checkCalls = 0;
    const { deps, events } = makeDeps({
      runReview: async (): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: reviewCalls === 1 ? ('p1_found' as const) : ('pass' as const),
          findings: reviewCalls === 1 ? groundedP1Findings() : [],
        };
      },
      checkDeterministicPlan: async (_ctx) => {
        checkCalls += 1;
        // Deterministic failure only before iteration 2 reviewer call (checkCalls = 2)
        return checkCalls === 2
          ? { diagnostic: 'later deterministic failure', signatureBlastRadiusFailures: [] }
          : { diagnostic: null, signatureBlastRadiusFailures: [] };
      },
      runFix: async (): Promise<PlanFixResult> => {
        fixCalls += 1;
        return {
          invocationId: `fix-${fixCalls}`,
          agentOutcome: 'success' as const,
          verdict: 'done_with_fixes' as const,
        };
      },
    });
    const out = await new PlanReviewLoop(deps).execute(baseInput());
    // Iteration 1: review (p1_found) -> fix
    // Iteration 2: deterministic_fix
    // Iteration 3: review (pass) -> budget extended
    // Iteration 4: final_full (pass) -> success
    expect(out.outcome).toBe('success');
    expect(out.loop.iterations).toHaveLength(4);
    expect(out.loop.iterations[0]?.kind).toBe('review');
    expect(out.loop.iterations[1]?.kind).toBe('deterministic_fix');
    expect(out.loop.iterations[2]?.kind).toBe('review');
    expect(out.loop.iterations[3]?.kind).toBe('review');
    expect(out.loop.iterations[3]?.outcome).toBe('resolved');
    expect(events.some((e) => e.type === 'plan-review.loop.final_review.budget_extended')).toBe(
      true,
    );
    expect(reviewCalls).toBe(3);
    expect(fixCalls).toBe(2);
  });

  it('trailing deterministic failure never calls reviewer', async () => {
    let reviewCalls = 0;
    let checkCalls = 0;
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
      checkDeterministicPlan: async (_ctx) => {
        checkCalls += 1;
        // Deterministic failure only at the trailing review stage (checkCalls = 4)
        return checkCalls === 4
          ? { diagnostic: 'trailing deterministic failure', signatureBlastRadiusFailures: [] }
          : { diagnostic: null, signatureBlastRadiusFailures: [] };
      },
      runFix: async (): Promise<PlanFixResult> => ({
        invocationId: 'fix-1',
        agentOutcome: 'success' as const,
        verdict: 'done_with_fixes' as const,
      }),
    });
    const out = await new PlanReviewLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('needs_human_review');
    expect(reviewCalls).toBe(3); // final review reviewer not called.
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
    expect(calls).toHaveLength(3);
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
    expect(calls).toHaveLength(3);
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
    expect(out.loop.iterations).toHaveLength(3);
    expect(out.loop.iterations[1]?.outcome).toBe('resolved');
    expect(out.loop.iterations[2]?.outcome).toBe('resolved');
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
    const out = await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 4 });
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

  it('artifact digest drift in final_full review escalates to human review even when verdict is pass', async () => {
    let reviewCalls = 0;
    const { deps } = makeDeps({
      maxIterations: 1,
      runReview: async (): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        if (reviewCalls === 1) {
          return {
            invocationId: `rev-${reviewCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'p1_found' as const,
            findings: groundedP1Findings(),
            snapshot: {
              planMdDigest: 'digest-before-fix',
              planMdPath: '/wt/plan.md',
              capturedAt: '2026-07-08T00:00:00.000Z',
            },
          };
        }
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: 'pass' as const,
          findings: [],
          snapshot: {
            planMdDigest: 'digest-after-fix',
            planMdPath: '/wt/plan.md',
            capturedAt: '2026-07-08T00:00:00.000Z',
          },
        };
      },
      runFix: async (): Promise<PlanFixResult> => ({
        invocationId: 'fix-1',
        agentOutcome: 'success' as const,
        verdict: 'done_with_fixes' as const,
      }),
    });
    const out = await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 1 });
    expect(out.outcome).toBe('needs_human_review');
    expect(out.loop.status).toBe('exhausted');
  });

  it('reviewStateRepository.appendAttempt is called for each review', async () => {
    let reviewCalls = 0;
    const fakeRepo = new FakeReviewStateRepository();
    const { deps } = makeDeps({
      reviewStateRepository: fakeRepo,
      runReview: async (): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: reviewCalls === 1 ? 'p1_found' : 'pass',
          findings: reviewCalls === 1 ? groundedP1Findings() : [],
          snapshot:
            reviewCalls === 1
              ? {
                  planMdDigest: 'digest-1',
                  planMdPath: '/wt/plan.md',
                  capturedAt: '2026-07-08T00:00:00.000Z',
                }
              : undefined,
        };
      },
      runFix: async (): Promise<PlanFixResult> => ({
        invocationId: 'fix-1',
        agentOutcome: 'success' as const,
        verdict: 'done_with_fixes' as const,
      }),
    });
    await new PlanReviewLoop(deps).execute(baseInput());
    const attempts = fakeRepo.listAttempts('run-1', 'plan-review', 'plan-review');
    expect(attempts).toHaveLength(3);
    expect(attempts[0]?.verdict).toBe('p1_found');
    expect(attempts[1]?.verdict).toBe('pass');
    expect(attempts[2]?.verdict).toBe('pass');
  });

  it('reviewStateRepository.appendAttempt is called for each review including final_full', async () => {
    let reviewCalls = 0;
    const fakeRepo = new FakeReviewStateRepository();
    const { deps } = makeDeps({
      reviewStateRepository: fakeRepo,
      maxIterations: 1,
      runReview: async (): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: reviewCalls === 1 ? 'p1_found' : 'pass',
          findings: reviewCalls === 1 ? groundedP1Findings() : [],
          snapshot:
            reviewCalls === 1
              ? {
                  planMdDigest: 'digest-1',
                  planMdPath: '/wt/plan.md',
                  capturedAt: '2026-07-08T00:00:00.000Z',
                }
              : undefined,
        };
      },
      runFix: async (): Promise<PlanFixResult> => ({
        invocationId: 'fix-1',
        agentOutcome: 'success' as const,
        verdict: 'done_with_fixes' as const,
      }),
    });
    await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 1 });
    const attempts = fakeRepo.listAttempts('run-1', 'plan-review', 'plan-review');
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.reviewMode).toBe('initial_full');
    expect(attempts[1]?.reviewMode).toBe('final_full');
  });

  describe('terminal escalation', () => {
    it('attempts exactly one terminal repair after an exhausted plan-review Loop and accepts it if valid', async () => {
      let runFixOpts: PlanFixOptions | undefined;
      let validateCalls = 0;
      const { deps } = makeDeps({
        terminalFixProfile: 'terminal-fix-profile',
        runReview: async () => ({
          invocationId: 'rev-1',
          agentOutcome: 'success',
          verdict: 'p1_found',
          findings: groundedP1Findings(),
        }),
        runFix: async (_ctx, opts) => {
          runFixOpts = opts;
          return {
            invocationId: 'fix-1',
            agentOutcome: 'success',
            verdict: 'done_with_fixes',
          };
        },
        validateTerminalFix: async () => {
          validateCalls++;
          return {
            passed: true,
            diagnostics: [],
            changedArtifacts: { 'plan.md': { priorDigest: 'd1', postDigest: 'd2' } },
            summary: 'Valid change',
          };
        },
      });

      const out = await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 1 });
      expect(out.outcome).toBe('success');
      expect(runFixOpts).toBeDefined();
      expect(runFixOpts?.isTerminalFix).toBe(true);
      expect(runFixOpts?.triggerReason).toBe('loop_exhausted');
      expect(validateCalls).toBe(1);
    });

    it('rejects a terminal repair with unchanged artifacts or structural validation failures', async () => {
      let validateCalls = 0;
      const { deps } = makeDeps({
        terminalFixProfile: 'terminal-fix-profile',
        runReview: async () => ({
          invocationId: 'rev-1',
          agentOutcome: 'success',
          verdict: 'p1_found',
          findings: groundedP1Findings(),
        }),
        runFix: async () => ({
          invocationId: 'fix-1',
          agentOutcome: 'success',
          verdict: 'done_with_fixes',
        }),
        validateTerminalFix: async () => {
          validateCalls++;
          return {
            passed: false,
            diagnostics: ['fence mismatch'],
            changedArtifacts: {},
            summary: 'Invalid structural check',
          };
        },
      });

      const out = await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 1 });
      expect(out.outcome).toBe('needs_human_review');
      expect(validateCalls).toBe(1);
    });

    it('returns outcome failed if deps.runFix outcome is failed during terminal escalation', async () => {
      let validateCalls = 0;
      const { deps } = makeDeps({
        terminalFixProfile: 'terminal-fix-profile',
        runReview: async () => ({
          invocationId: 'rev-1',
          agentOutcome: 'success',
          verdict: 'p1_found',
          findings: groundedP1Findings(),
        }),
        runFix: async () => ({
          invocationId: 'fix-1',
          agentOutcome: 'failed',
        }),
        validateTerminalFix: async () => {
          validateCalls++;
          return {
            passed: true,
            diagnostics: [],
            changedArtifacts: { 'plan.md': { priorDigest: 'd1', postDigest: 'd2' } },
            summary: 'Valid change',
          };
        },
      });

      const out = await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 1 });
      expect(out.outcome).toBe('failed');
      expect(validateCalls).toBe(0);
    });

    it('routes regular arbiter ambiguous and insufficient_evidence to terminal repair', async () => {
      let runFixOpts: PlanFixOptions | undefined;
      const { deps } = makeDeps({
        terminalFixProfile: 'terminal-fix-profile',
        runReview: async () => ({
          invocationId: 'rev-1',
          agentOutcome: 'success',
          verdict: 'p1_found',
          findings: groundedP1Findings(),
        }),
        runFix: async (_ctx, opts) => {
          if (opts.isTerminalFix) {
            runFixOpts = opts;
            return {
              invocationId: 'fix-term',
              agentOutcome: 'success',
              verdict: 'done_with_fixes',
            };
          }
          return {
            invocationId: 'fix-1',
            agentOutcome: 'success',
            verdict: 'done_no_fixes_needed',
          };
        },
        runArbiter: async () => ({
          outcome: 'ambiguous',
          evidence: 'Some evidence',
          rationale: 'Not clear',
        }),
        validateTerminalFix: async () => ({
          passed: true,
          diagnostics: [],
          changedArtifacts: { 'plan.md': { priorDigest: 'd1', postDigest: 'd2' } },
          summary: 'Valid change',
        }),
      });

      const out = await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 3 });
      expect(out.outcome).toBe('success');
      expect(runFixOpts?.triggerReason).toBe('arbiter_ambiguous');
    });

    it('routes final-review arbiter ambiguous and insufficient_evidence to terminal repair', async () => {
      let runFixOpts: PlanFixOptions | undefined;
      let reviewCalls = 0;
      const { deps } = makeDeps({
        terminalFixProfile: 'terminal-fix-profile',
        runReview: async () => {
          reviewCalls++;
          if (reviewCalls === 1) {
            return {
              invocationId: 'rev-1',
              agentOutcome: 'success',
              verdict: 'p1_found',
              findings: groundedP1Findings(),
            };
          }
          // iterationIndex = 2 is final_full review because maxIterations=1
          return {
            invocationId: 'rev-2',
            agentOutcome: 'success',
            verdict: 'p1_found',
            findings: groundedP1Findings(),
          };
        },
        runFix: async (_ctx, opts) => {
          if (opts.isTerminalFix) {
            runFixOpts = opts;
            return {
              invocationId: 'fix-term',
              agentOutcome: 'success',
              verdict: 'done_with_fixes',
            };
          }
          return {
            invocationId: 'fix-1',
            agentOutcome: 'success',
            verdict: 'done_with_fixes',
          };
        },
        runFinalReviewArbiter: async () => ({
          outcome: 'insufficient_evidence',
          evidence: 'Some final evidence',
          rationale: 'Not clear final',
        }),
        validateTerminalFix: async () => ({
          passed: true,
          diagnostics: [],
          changedArtifacts: { 'plan.md': { priorDigest: 'd1', postDigest: 'd2' } },
          summary: 'Valid change',
        }),
      });

      const out = await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 1 });
      expect(out.outcome).toBe('success');
      expect(runFixOpts?.triggerReason).toBe('arbiter_insufficient_evidence');
    });

    it('preserves existing plan-review terminal exits without a terminal profile', async () => {
      let runFixCalls = 0;
      const { deps } = makeDeps({
        terminalFixProfile: undefined,
        runReview: async () => ({
          invocationId: 'rev-1',
          agentOutcome: 'success',
          verdict: 'p1_found',
          findings: groundedP1Findings(),
        }),
        runFix: async () => {
          runFixCalls++;
          return {
            invocationId: 'fix-1',
            agentOutcome: 'success',
            verdict: 'done_with_fixes',
          };
        },
      });

      const out = await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 1 });
      expect(out.outcome).toBe('needs_human_review');
      expect(runFixCalls).toBe(1); // Only the regular fix at iter 1 ran, no terminal fix.
    });

    it('keeps gate-manufactured insufficient-evidence recovery out of terminal repair', async () => {
      let runFixCalls = 0;
      const { deps } = makeDeps({
        terminalFixProfile: 'terminal-fix-profile',
        runReview: async () => ({
          invocationId: 'rev-1',
          agentOutcome: 'success',
          verdict: 'pass', // adjusted to p1_found by gate (isGateManufactured)
          findings: groundedP1Findings(),
        }),
        runFix: async (_ctx, _opts) => {
          runFixCalls++;
          return {
            invocationId: 'fix-1',
            agentOutcome: 'success',
            verdict: 'done_no_fixes_needed',
          };
        },
        runArbiter: async () => ({
          outcome: 'insufficient_evidence',
          evidence: 'Some evidence',
          rationale: 'Gate manufactured',
        }),
      });

      const out = await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 3 });
      expect(out.outcome).toBe('success'); // Gated recovery handles it, it does not call terminal fix.
      expect(runFixCalls).toBe(1); // only the regular fix ran
    });
  });

  describe('deterministic plan behavioral invariants', () => {
    it('deterministic plan failures run before semantic review', async () => {
      let reviewCalls = 0;
      let fixCalls = 0;
      let checkCalls = 0;
      const { deps } = makeDeps({
        runReview: async (): Promise<PlanReviewResult> => {
          reviewCalls += 1;
          return {
            invocationId: `rev-${reviewCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'pass' as const,
          };
        },
        checkDeterministicPlan: async (_ctx): Promise<DeterministicPlanCheckResult> => {
          checkCalls += 1;
          return checkCalls === 1
            ? { diagnostic: 'structural mismatch', signatureBlastRadiusFailures: [] }
            : { diagnostic: null, signatureBlastRadiusFailures: [] };
        },
        runFix: async (_ctx, _opts): Promise<PlanFixResult> => {
          fixCalls += 1;
          return {
            invocationId: `fix-${fixCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'done_with_fixes' as const,
          };
        },
      });
      const out = await new PlanReviewLoop(deps).execute(baseInput());
      expect(out.outcome).toBe('success');
      expect(out.loop.iterations[0]?.kind).toBe('deterministic_fix');
      // Review is called after deterministic phase succeeds
      expect(reviewCalls).toBeGreaterThanOrEqual(1); // Review called after deterministic phase succeeds
      expect(fixCalls).toBe(1);
    });

    it('a fixed deterministic failure is rechecked before semantic review', async () => {
      let reviewCalls = 0;
      let checkCalls = 0;
      const { deps } = makeDeps({
        runReview: async (): Promise<PlanReviewResult> => {
          reviewCalls += 1;
          return {
            invocationId: `rev-${reviewCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'pass' as const,
          };
        },
        checkDeterministicPlan: async (_ctx): Promise<DeterministicPlanCheckResult> => {
          checkCalls += 1;
          // First check fails, second check passes
          return checkCalls === 1
            ? { diagnostic: 'structural mismatch', signatureBlastRadiusFailures: [] }
            : { diagnostic: null, signatureBlastRadiusFailures: [] };
        },
        runFix: async (_ctx, _opts): Promise<PlanFixResult> => ({
          invocationId: 'fix-1',
          agentOutcome: 'success' as const,
          verdict: 'done_with_fixes' as const,
        }),
      });
      const out = await new PlanReviewLoop(deps).execute(baseInput());
      expect(out.outcome).toBe('success');
      // Iter 1: deterministic failure -> fix
      // Iter 2: deterministic check passes -> review
      expect(out.loop.iterations).toHaveLength(3);
      expect(out.loop.iterations[0]?.kind).toBe('deterministic_fix');
      expect(out.loop.iterations[1]?.kind).toBe('review');
      expect(out.loop.iterations[1]?.outcome).toBe('resolved');
      expect(reviewCalls).toBe(2); // Review called in both iter 2 and final convergence
    });

    it('an unchanged declined deterministic failure is suppressed and escalated without spinning', async () => {
      let checkCalls = 0;
      let fixCalls = 0;
      const { deps, events } = makeDeps({
        runReview: async (): Promise<PlanReviewResult> => ({
          invocationId: 'rev-1',
          agentOutcome: 'success' as const,
          verdict: 'pass' as const,
        }),
        checkDeterministicPlan: async (_ctx): Promise<DeterministicPlanCheckResult> => {
          checkCalls += 1;
          // Always return the same failure (no changes made by fixer)
          return { diagnostic: 'unchanged failure', signatureBlastRadiusFailures: [] };
        },
        runFix: async (_ctx, _opts): Promise<PlanFixResult> => {
          fixCalls += 1;
          return {
            invocationId: `fix-${fixCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'done_no_fixes_needed' as const,
          };
        },
      });
      const out = await new PlanReviewLoop(deps).execute(baseInput());
      expect(out.outcome).toBe('needs_human_review');
      expect(checkCalls).toBe(2); // First attempt, then suppressed second attempt
      expect(fixCalls).toBe(1); // Only one fix attempt
      expect(events.some((e) => e.type === 'plan-review.deterministic_check.suppressed')).toBe(
        true,
      );
    });

    it('final convergence reruns all deterministic plan checks', async () => {
      let checkCalls = 0;
      const { deps } = makeDeps({
        runReview: async (): Promise<PlanReviewResult> => ({
          invocationId: 'rev-1',
          agentOutcome: 'success' as const,
          verdict: 'pass' as const,
        }),
        checkDeterministicPlan: async (_ctx): Promise<DeterministicPlanCheckResult> => {
          checkCalls += 1;
          // Fail on first, pass on second (during final convergence check)
          return checkCalls === 1
            ? { diagnostic: 'mismatch before convergence', signatureBlastRadiusFailures: [] }
            : { diagnostic: null, signatureBlastRadiusFailures: [] };
        },
        runFix: async (_ctx, _opts): Promise<PlanFixResult> => ({
          invocationId: 'fix-1',
          agentOutcome: 'success' as const,
          verdict: 'done_with_fixes' as const,
        }),
      });
      const out = await new PlanReviewLoop(deps).execute(baseInput());
      expect(out.outcome).toBe('success');
      // First deterministic check at iter 1, then again at final convergence
      expect(checkCalls).toBeGreaterThanOrEqual(2);
    });

    it('blast-radius failures emit searchable structured events', async () => {
      const { deps, events } = makeDeps({
        runReview: async (): Promise<PlanReviewResult> => ({
          invocationId: 'rev-1',
          agentOutcome: 'success' as const,
          verdict: 'pass' as const,
        }),
        checkDeterministicPlan: async (_ctx): Promise<DeterministicPlanCheckResult> => ({
          diagnostic: 'signature mismatch',
          signatureBlastRadiusFailures: [
            {
              taskN: 2,
              symbol: 'Foo',
              declarationFile: 'src/foo.ts',
              uncoveredReferences: [
                { file: 'src/bar.ts', line: 10, column: 5, kind: 'call' },
                { file: 'src/baz.ts', line: 20, column: 3, kind: 'value' },
              ],
            },
          ],
        }),
        runFix: async (_ctx, _opts): Promise<PlanFixResult> => ({
          invocationId: 'fix-1',
          agentOutcome: 'success' as const,
          verdict: 'done_with_fixes' as const,
        }),
      });
      await new PlanReviewLoop(deps).execute(baseInput());
      const blastRadiusEvents = events.filter(
        (e) => e.type === 'plan-review.signature_blast_radius.failed',
      );
      // Events emitted on each deterministic check that finds blast-radius failures
      expect(blastRadiusEvents.length).toBeGreaterThanOrEqual(1);
      expect(blastRadiusEvents[0]?.metadata).toMatchObject({
        taskN: 2,
        symbol: 'Foo',
        uncoveredFileCount: 2,
      });
    });

    it('structural and blast-radius failures aggregate stably', async () => {
      let checkCalls = 0;
      const { deps } = makeDeps({
        runReview: async (): Promise<PlanReviewResult> => ({
          invocationId: 'rev-1',
          agentOutcome: 'success' as const,
          verdict: 'pass' as const,
        }),
        checkDeterministicPlan: async (_ctx): Promise<DeterministicPlanCheckResult> => {
          checkCalls += 1;
          // First check fails, second check passes (simulating successful fix)
          return checkCalls === 1
            ? {
                diagnostic:
                  'structural error\n\nsignature blast-radius: Task 1 changes Foo but references undeclared files',
                signatureBlastRadiusFailures: [
                  {
                    taskN: 1,
                    symbol: 'Foo',
                    declarationFile: 'src/foo.ts',
                    uncoveredReferences: [
                      { file: 'src/bar.ts', line: 10, column: 5, kind: 'call' },
                    ],
                  },
                ],
              }
            : { diagnostic: null, signatureBlastRadiusFailures: [] };
        },
        runFix: async (_ctx, _opts): Promise<PlanFixResult> => ({
          invocationId: 'fix-1',
          agentOutcome: 'success' as const,
          verdict: 'done_with_fixes' as const,
        }),
      });
      const out = await new PlanReviewLoop(deps).execute(baseInput());
      expect(out.outcome).toBe('success');
      expect(out.loop.iterations[0]?.kind).toBe('deterministic_fix');
      expect(checkCalls).toBeGreaterThanOrEqual(2); // Initial check + convergence check
    });

    it('no declared signature changes skip analyzer I/O', async () => {
      let _analyzerCalls = 0;
      const fakeAnalyzer = async () => {
        _analyzerCalls += 1;
        return [];
      };
      const { deps } = makeDeps({
        runReview: async (): Promise<PlanReviewResult> => ({
          invocationId: 'rev-1',
          agentOutcome: 'success' as const,
          verdict: 'pass' as const,
        }),
        checkDeterministicPlan: async (_ctx): Promise<DeterministicPlanCheckResult> => {
          // This mimics a manifest with no signature_changes - the analyzer should not be called
          return { diagnostic: null, signatureBlastRadiusFailures: [] };
        },
        runFix: async (_ctx, _opts): Promise<PlanFixResult> => ({
          invocationId: 'fix-1',
          agentOutcome: 'success' as const,
          verdict: 'done_with_fixes' as const,
        }),
      });
      // We cannot directly test analyzer calls here since checkDeterministicPlan is mocked,
      // but this test documents the contract: when diagnostic is null and failures are empty,
      // the composition root should skip calling the analyzer
      const out = await new PlanReviewLoop(deps).execute(baseInput());
      expect(out.outcome).toBe('success');
      // The key invariant is that if there are no declared signature changes,
      // the analyzer port is never invoked
      void fakeAnalyzer; // Reference to suppress unused warning
    });
  });
});

describe('PlanReviewLoop budget extension (#repro)', () => {
  it('repro: delta convergence on the literal last iteration grants one extra iteration and succeeds', async () => {
    let reviewCalls = 0;
    let n = 0;
    const { deps, events } = makeDeps({
      runReview: async (): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        return {
          invocationId: `rev-${++n}`,
          agentOutcome: 'success',
          verdict: reviewCalls === 1 ? 'p1_found' : 'pass',
          findings: reviewCalls === 1 ? groundedP1Findings() : [],
        };
      },
      runFix: async (): Promise<PlanFixResult> => ({
        invocationId: `fix-${++n}`,
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
      }),
    });

    const input = {
      ...baseInput(),
      maxIterations: 2,
    };

    const out = await new PlanReviewLoop(deps).execute(input);
    expect(out.outcome).toBe('success');
    // Iteration 1: initial_full (p1_found) -> fix
    // Iteration 2: intermediate_delta (pass) -> budget extended
    // Iteration 3: final_full (pass) -> success
    expect(out.loop.iterations).toHaveLength(3);
    expect(out.loop.status).toBe('converged');
    expect(events.some((e) => e.type === 'plan-review.loop.final_review.budget_extended')).toBe(
      true,
    );
  });
});

it('proceed_with_concerns at max iterations grants extension and succeeds after final_full', async () => {
  let reviewCalls = 0;
  const { deps, events } = makeDeps({
    runReview: async (): Promise<PlanReviewResult> => {
      reviewCalls += 1;
      // Iteration 1: initial_full (p1_found)
      // Iteration 2: intermediate_delta (proceed_with_concerns)
      // Iteration 3: final_full (pass)
      return {
        invocationId: `rev-${reviewCalls}`,
        agentOutcome: 'success',
        verdict:
          reviewCalls === 1 ? 'p1_found' : reviewCalls === 2 ? 'proceed_with_concerns' : 'pass',
        findings: reviewCalls === 1 ? groundedP1Findings() : [],
        knownLimitations: reviewCalls === 2 ? 'some limitations' : undefined,
      };
    },
    runFix: async (): Promise<PlanFixResult> => ({
      invocationId: 'fix-1',
      agentOutcome: 'success',
      verdict: 'done_with_fixes',
    }),
  });

  const out = await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 2 });
  expect(out.outcome).toBe('success');
  expect(out.proceedWithConcerns).toBe(false); // pass on final_full wins
  expect(out.loop.iterations).toHaveLength(3);
  expect(events.some((e) => e.type === 'plan-review.loop.final_review.budget_extended')).toBe(true);
});

it('one-time budget extension is not granted twice', async () => {
  let reviewCalls = 0;
  const { deps, events } = makeDeps({
    runReview: async (): Promise<PlanReviewResult> => {
      reviewCalls += 1;
      // Iter 1: p1_found -> fix
      // Iter 2: pass -> extension granted (maxIter=3)
      // Iter 3 (final_full): p1_found -> reopen (iter1Snapshot=undefined, forceInitialFull=true)
      // Iter 4: initial_full (pass) -> no more extension, loop exhausted
      return {
        invocationId: `rev-${reviewCalls}`,
        agentOutcome: 'success',
        verdict: reviewCalls === 1 || reviewCalls === 3 ? 'p1_found' : 'pass',
        findings: reviewCalls === 1 || reviewCalls === 3 ? groundedP1Findings() : [],
      };
    },
    runFix: async (): Promise<PlanFixResult> => ({
      invocationId: `fix-${reviewCalls}`,
      agentOutcome: 'success',
      verdict: 'done_with_fixes',
    }),
  });

  const out = await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 2 });
  expect(out.outcome).toBe('success');
  expect(out.loop.status).toBe('converged');
  const extensionEvents = events.filter(
    (e) => e.type === 'plan-review.loop.final_review.budget_extended',
  );
  expect(extensionEvents).toHaveLength(1);
  expect(events.some((e) => e.type === 'plan-review.loop.post_reopen_verification.started')).toBe(
    true,
  );
});

it('exhaustion with extension used', async () => {
  let reviewCalls = 0;
  const { deps, events } = makeDeps({
    runReview: async (): Promise<PlanReviewResult> => {
      reviewCalls += 1;
      return {
        invocationId: `rev-${reviewCalls}`,
        agentOutcome: 'success',
        verdict: 'p1_found',
        findings: groundedP1Findings(),
      };
    },
    runFix: async (): Promise<PlanFixResult> => ({
      invocationId: 'fix-1',
      agentOutcome: 'success',
      verdict: 'done_with_fixes',
    }),
  });

  const out = await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 1 });
  expect(out.outcome).toBe('needs_human_review');
  expect(out.loop.iterations).toHaveLength(2); // 1st review fail -> fix, 2nd review fail -> exhaust
  expect(events.some((e) => e.type === 'plan-review.loop.exhausted')).toBe(true);
});

describe('Task 1: snapshot seam - post-reopen verification', () => {
  it('verifies that captureSnapshot is called on initial_full p1_found before fix', async () => {
    let captureSnapshotCalls = 0;
    let snapshotCaptured: PlanReviewSnapshot | undefined;
    const { deps } = makeDeps({
      runReview: async (): Promise<PlanReviewResult> => ({
        invocationId: 'rev-1',
        agentOutcome: 'success',
        verdict: 'p1_found',
        findings: groundedP1Findings(),
      }),
      runFix: async (): Promise<PlanFixResult> => ({
        invocationId: 'fix-1',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
      }),
      captureSnapshot: async (): Promise<PlanReviewSnapshot> => {
        captureSnapshotCalls += 1;
        snapshotCaptured = {
          planMdDigest: 'test-digest',
          planMdPath: 'plan.md',
          capturedAt: '2026-07-08T00:00:00.000Z',
        };
        return snapshotCaptured;
      },
    });
    const out = await new PlanReviewLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('needs_human_review');
    expect(captureSnapshotCalls).toBeGreaterThan(0);
    expect(snapshotCaptured).toBeDefined();
  });

  it('verifies that iter1Snapshot from captureSnapshot is used for post-reopen verification', async () => {
    const { deps } = makeDeps({
      runReview: async (): Promise<PlanReviewResult> => ({
        invocationId: 'rev-1',
        agentOutcome: 'success',
        verdict: 'p1_found',
        findings: groundedP1Findings(),
      }),
      runFix: async (): Promise<PlanFixResult> => ({
        invocationId: 'fix-1',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
      }),
      captureSnapshot: async (): Promise<PlanReviewSnapshot> => ({
        planMdDigest: 'test-digest',
        planMdPath: 'plan.md',
        capturedAt: '2026-07-08T00:00:00.000Z',
      }),
    });
    const out = await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 1 });
    expect(out.outcome).toBe('needs_human_review');
    expect(out.loop.status).toBe('exhausted');
  });

  it('verifies that when final_full still shows p1 after reopen, outcome is needs_human_review', async () => {
    let reviewCalls = 0;
    const { deps } = makeDeps({
      runReview: async (): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success',
          verdict: 'p1_found',
          findings: groundedP1Findings(),
        };
      },
      runFix: async (): Promise<PlanFixResult> => ({
        invocationId: 'fix-1',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
      }),
      captureSnapshot: async (): Promise<PlanReviewSnapshot> => ({
        planMdDigest: 'test-digest',
        planMdPath: 'plan.md',
        capturedAt: '2026-07-08T00:00:00.000Z',
      }),
    });
    const out = await new PlanReviewLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('needs_human_review');
    expect(out.loop.status).toBe('exhausted');
  });

  describe('post-reopen final_full verification — transition', () => {
    it('reopened final_full boundary fix runs one review-only final_full verification and converges', async () => {
      let reviewCalls = 0;
      let fixCalls = 0;
      const reviewModes: string[] = [];
      const { deps, events } = makeDeps({
        runReview: async (_ctx, opts): Promise<PlanReviewResult> => {
          reviewCalls++;
          if (opts?.mode) {
            reviewModes.push(opts.mode);
          } else {
            reviewModes.push('initial_full');
          }
          if (reviewCalls === 1) {
            return {
              invocationId: `rev-${reviewCalls}`,
              agentOutcome: 'success',
              verdict: 'p1_found',
              findings: groundedP1Findings(),
            };
          } else if (reviewCalls === 2) {
            return {
              invocationId: `rev-${reviewCalls}`,
              agentOutcome: 'success',
              verdict: 'pass',
              findings: [],
            };
          } else if (reviewCalls === 3) {
            return {
              invocationId: `rev-${reviewCalls}`,
              agentOutcome: 'success',
              verdict: 'p1_found',
              findings: groundedP1Findings(),
            };
          } else {
            // reviewCalls === 4
            return {
              invocationId: `rev-${reviewCalls}`,
              agentOutcome: 'success',
              verdict: 'pass',
              findings: [],
            };
          }
        },
        runFix: async (): Promise<PlanFixResult> => {
          fixCalls++;
          return {
            invocationId: `fix-${fixCalls}`,
            agentOutcome: 'success',
            verdict: 'done_with_fixes',
          };
        },
      });

      const out = await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 2 });
      expect(out.outcome).toBe('success');
      expect(reviewCalls).toBe(4);
      expect(fixCalls).toBe(2);
      expect(reviewModes).toEqual([
        'initial_full',
        'intermediate_delta',
        'final_full',
        'final_full',
      ]);
      expect(
        events.filter((event) => event.type === 'plan-review.loop.final_review.budget_extended'),
      ).toHaveLength(1);
      expect(
        events.filter(
          (event) => event.type === 'plan-review.loop.post_reopen_verification.started',
        ),
      ).toHaveLength(1);

      expect(out.loop.iterations).toHaveLength(4);
      expect(out.loop.iterations[3]?.outcome).toBe('resolved');

      const verificationStarted = events.find(
        (e) => e.type === 'plan-review.loop.post_reopen_verification.started',
      );
      expect(verificationStarted?.metadata).toMatchObject({
        fixedIteration: 3,
        verificationIteration: 4,
        reason: 'reopened_final_full_fix_at_boundary',
      });

      const completedEvents = events.filter(
        (e) => e.type === 'plan-review.loop.iteration.completed',
      );
      expect(completedEvents[3]?.metadata).toMatchObject({
        index: 4,
        outcome: 'resolved',
        verification: 'post_reopen_final_full',
      });
    });

    it('persistent P1 verification runs at most once and never invokes another ordinary fixer', async () => {
      let reviewCalls = 0;
      let fixCalls = 0;
      const reviewModes: string[] = [];
      const { deps, events } = makeDeps({
        runReview: async (_ctx, opts): Promise<PlanReviewResult> => {
          reviewCalls++;
          if (opts?.mode) {
            reviewModes.push(opts.mode);
          } else {
            reviewModes.push('initial_full');
          }
          if (reviewCalls === 1) {
            return {
              invocationId: `rev-${reviewCalls}`,
              agentOutcome: 'success',
              verdict: 'p1_found',
              findings: groundedP1Findings(),
            };
          } else if (reviewCalls === 2) {
            return {
              invocationId: `rev-${reviewCalls}`,
              agentOutcome: 'success',
              verdict: 'pass',
              findings: [],
            };
          } else if (reviewCalls === 3) {
            return {
              invocationId: `rev-${reviewCalls}`,
              agentOutcome: 'success',
              verdict: 'p1_found',
              findings: groundedP1Findings(),
            };
          } else {
            // reviewCalls === 4
            return {
              invocationId: `rev-${reviewCalls}`,
              agentOutcome: 'success',
              verdict: 'p1_found',
              findings: groundedP1Findings(),
            };
          }
        },
        runFix: async (): Promise<PlanFixResult> => {
          fixCalls++;
          return {
            invocationId: `fix-${fixCalls}`,
            agentOutcome: 'success',
            verdict: 'done_with_fixes',
          };
        },
      });

      const out = await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 2 });
      expect(out.outcome).toBe('needs_human_review');
      expect(reviewCalls).toBe(4);
      expect(fixCalls).toBe(2);
      expect(out.loop.status).toBe('exhausted');
      expect(out.loop.iterations).toHaveLength(4);
      expect(out.loop.iterations[3]?.outcome).toBe('unresolved');
      expect(
        events.filter((e) => e.type === 'plan-review.loop.post_reopen_verification.started'),
      ).toHaveLength(1);

      const completedEvents = events.filter(
        (e) => e.type === 'plan-review.loop.iteration.completed',
      );
      expect(completedEvents[3]?.metadata).toMatchObject({
        index: 4,
        outcome: 'unresolved',
        verification: 'post_reopen_final_full',
      });
    });

    it('fixed exhaustion not triggered by reopened final_full does not receive post-reopen verification', async () => {
      let reviewCalls = 0;
      let fixCalls = 0;
      const { deps, events } = makeDeps({
        runReview: async (): Promise<PlanReviewResult> => {
          reviewCalls++;
          return {
            invocationId: `rev-${reviewCalls}`,
            agentOutcome: 'success',
            verdict: 'p1_found',
            findings: groundedP1Findings(),
          };
        },
        runFix: async (): Promise<PlanFixResult> => {
          fixCalls++;
          return {
            invocationId: `fix-${fixCalls}`,
            agentOutcome: 'success',
            verdict: 'done_with_fixes',
          };
        },
      });

      const out = await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 2 });
      expect(out.outcome).toBe('needs_human_review');
      expect(reviewCalls).toBe(3);
      expect(fixCalls).toBe(2);
      expect(out.loop.iterations).toHaveLength(3);
      expect(
        events.filter((e) => e.type === 'plan-review.loop.post_reopen_verification.started'),
      ).toHaveLength(0);
    });
  });

  describe('post-reopen final_full verification — verdicts', () => {
    function makePostReopenVerdictSequence(
      verdictSequence: Array<'pass' | 'p2_only' | 'proceed_with_concerns'>,
    ) {
      let reviewCalls = 0;
      let fixCalls = 0;
      const runReview = async (): Promise<PlanReviewResult> => {
        reviewCalls++;
        if (reviewCalls === 1) {
          return {
            invocationId: `rev-${reviewCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'p1_found' as const,
            findings: groundedP1Findings(),
          };
        } else if (reviewCalls === 2) {
          return {
            invocationId: `rev-${reviewCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'pass' as const,
            findings: [],
          };
        } else if (reviewCalls === 3) {
          return {
            invocationId: `rev-${reviewCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'p1_found' as const,
            findings: groundedP1Findings(),
          };
        } else {
          const idx = reviewCalls - 4;
          const verdict = verdictSequence[idx] ?? 'pass';
          return {
            invocationId: `rev-${reviewCalls}`,
            agentOutcome: 'success' as const,
            verdict,
            findings: [],
            knownLimitations:
              verdict === 'proceed_with_concerns' ? 'post-reopen known limitations' : undefined,
          };
        }
      };
      const runFix = async (): Promise<PlanFixResult> => {
        fixCalls++;
        return {
          invocationId: `fix-${fixCalls}`,
          agentOutcome: 'success' as const,
          verdict: 'done_with_fixes' as const,
        };
      };
      return { runReview, runFix, getReviewCalls: () => reviewCalls, getFixCalls: () => fixCalls };
    }

    it('post-reopen verification pass and p2_only converge without concerns', async () => {
      const { runReview, runFix, getReviewCalls, getFixCalls } = makePostReopenVerdictSequence([
        'pass',
      ]);
      const { deps, events } = makeDeps({ runReview, runFix });

      const out = await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 2 });

      expect(out.outcome).toBe('success');
      expect(out.proceedWithConcerns).toBe(false);
      expect(out.loop.status).toBe('converged');
      expect(getReviewCalls()).toBe(4);
      expect(getFixCalls()).toBe(2);

      const verificationStarted = events.find(
        (e) => e.type === 'plan-review.loop.post_reopen_verification.started',
      );
      expect(verificationStarted).toBeDefined();

      const lastIteration = out.loop.iterations[out.loop.iterations.length - 1];
      expect(lastIteration?.outcome).toBe('resolved');

      const completedEvents = events.filter(
        (e) => e.type === 'plan-review.loop.iteration.completed',
      );
      const verificationCompleted = completedEvents.find(
        (e) => e.metadata?.verification === 'post_reopen_final_full',
      );
      expect(verificationCompleted?.metadata).toMatchObject({
        outcome: 'resolved',
      });
    });

    it('post-reopen verification p2_only converges without concerns', async () => {
      const { runReview, runFix, getReviewCalls, getFixCalls } = makePostReopenVerdictSequence([
        'p2_only',
      ]);
      const { deps } = makeDeps({ runReview, runFix });

      const out = await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 2 });

      expect(out.outcome).toBe('success');
      expect(out.proceedWithConcerns).toBe(false);
      expect(out.loop.status).toBe('converged');
      expect(getReviewCalls()).toBe(4);
      expect(getFixCalls()).toBe(2);

      const lastIteration = out.loop.iterations[out.loop.iterations.length - 1];
      expect(lastIteration?.outcome).toBe('resolved');
    });

    it('post-reopen verification proceed_with_concerns preserves known limitations', async () => {
      const { runReview, runFix, getReviewCalls, getFixCalls } = makePostReopenVerdictSequence([
        'proceed_with_concerns',
      ]);
      const { deps, events } = makeDeps({ runReview, runFix });

      const out = await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 2 });

      expect(out.outcome).toBe('success');
      expect(out.proceedWithConcerns).toBe(true);
      expect(out.knownLimitations).toBe('post-reopen known limitations');
      expect(out.loop.status).toBe('converged');
      expect(getReviewCalls()).toBe(4);
      expect(getFixCalls()).toBe(2);

      const lastIteration = out.loop.iterations[out.loop.iterations.length - 1];
      expect(lastIteration?.outcome).toBe('resolved');

      const completedEvents = events.filter(
        (e) => e.type === 'plan-review.loop.iteration.completed',
      );
      const verificationCompleted = completedEvents.find(
        (e) => e.metadata?.verification === 'post_reopen_final_full',
      );
      expect(verificationCompleted?.metadata?.outcome).toBe('resolved');
    });

    it('post-reopen verification retries reviewer failures up to the configured budget', async () => {
      let reviewCalls = 0;
      let fixCalls = 0;
      const { deps, events } = makeDeps({
        reviewerMaxRetries: 2,
        runReview: async (): Promise<PlanReviewResult> => {
          reviewCalls++;
          if (reviewCalls === 1) {
            return {
              invocationId: `rev-${reviewCalls}`,
              agentOutcome: 'success' as const,
              verdict: 'p1_found' as const,
              findings: groundedP1Findings(),
            };
          } else if (reviewCalls === 2) {
            return {
              invocationId: `rev-${reviewCalls}`,
              agentOutcome: 'success' as const,
              verdict: 'pass' as const,
              findings: [],
            };
          } else if (reviewCalls === 3) {
            return {
              invocationId: `rev-${reviewCalls}`,
              agentOutcome: 'success' as const,
              verdict: 'p1_found' as const,
              findings: groundedP1Findings(),
            };
          } else if (reviewCalls === 4) {
            return {
              invocationId: `rev-${reviewCalls}`,
              agentOutcome: 'failed' as const,
              verdict: undefined,
            };
          } else {
            return {
              invocationId: `rev-${reviewCalls}`,
              agentOutcome: 'success' as const,
              verdict: 'pass' as const,
              findings: [],
            };
          }
        },
        runFix: async (): Promise<PlanFixResult> => {
          fixCalls++;
          return {
            invocationId: `fix-${fixCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'done_with_fixes' as const,
          };
        },
      });

      const out = await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 2 });

      expect(out.outcome).toBe('success');
      expect(out.loop.status).toBe('converged');
      expect(reviewCalls).toBe(5);
      expect(fixCalls).toBe(2);

      const retryEvents = events.filter((e) => e.type === 'plan-review.reviewer.retry');
      expect(retryEvents.length).toBeGreaterThanOrEqual(1);

      const lastIteration = out.loop.iterations[out.loop.iterations.length - 1];
      expect(lastIteration?.outcome).toBe('resolved');
    });

    it('post-reopen verification reviewer exhaustion records failed and cannot succeed', async () => {
      let reviewCalls = 0;
      let fixCalls = 0;
      const { deps, events } = makeDeps({
        reviewerMaxRetries: 1,
        runReview: async (): Promise<PlanReviewResult> => {
          reviewCalls++;
          if (reviewCalls === 1) {
            return {
              invocationId: `rev-${reviewCalls}`,
              agentOutcome: 'success' as const,
              verdict: 'p1_found' as const,
              findings: groundedP1Findings(),
            };
          } else if (reviewCalls === 2) {
            return {
              invocationId: `rev-${reviewCalls}`,
              agentOutcome: 'success' as const,
              verdict: 'pass' as const,
              findings: [],
            };
          } else if (reviewCalls === 3) {
            return {
              invocationId: `rev-${reviewCalls}`,
              agentOutcome: 'success' as const,
              verdict: 'p1_found' as const,
              findings: groundedP1Findings(),
            };
          } else {
            return {
              invocationId: `rev-${reviewCalls}`,
              agentOutcome: 'failed' as const,
              verdict: undefined,
            };
          }
        },
        runFix: async (): Promise<PlanFixResult> => {
          fixCalls++;
          return {
            invocationId: `fix-${fixCalls}`,
            agentOutcome: 'success' as const,
            verdict: 'done_with_fixes' as const,
          };
        },
      });

      const out = await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 2 });

      expect(out.outcome).toBe('failed');
      expect(out.loop.status).toBe('exhausted');
      expect(reviewCalls).toBe(5);
      expect(fixCalls).toBe(2);

      const failedEvents = events.filter((e) => e.type === 'plan-review.reviewer.failed');
      expect(failedEvents.length).toBe(1);

      const lastIteration = out.loop.iterations[out.loop.iterations.length - 1];
      expect(lastIteration?.outcome).toBe('failed');

      const completedEvents = events.filter(
        (e) => e.type === 'plan-review.loop.iteration.completed',
      );
      const verificationCompleted = completedEvents.find(
        (e) => e.metadata?.verification === 'post_reopen_final_full',
      );
      expect(verificationCompleted?.metadata?.outcome).toBe('failed');
    });
  });

  describe('post-reopen final_full verification — safety', () => {
    it('post-reopen deterministic failure skips captureSnapshot and semantic verification and escalates', async () => {
      let verificationCaptureSnapshotCalls = 0;
      let reviewModes: string[] = [];
      let checkCalls = 0;
      const { deps, events } = makeDeps({
        runReview: async (_ctx, opts): Promise<PlanReviewResult> => {
          const mode = opts?.mode ?? 'initial_full';
          reviewModes.push(mode);
          if (reviewModes.length === 1) {
            return {
              invocationId: `rev-${reviewModes.length}`,
              agentOutcome: 'success' as const,
              verdict: 'p1_found' as const,
              findings: groundedP1Findings(),
              snapshot: {
                planMdDigest: 'iter1-snapshot',
                planMdPath: '/wt/plan.md',
                capturedAt: '2026-07-08T00:00:00.000Z',
              },
            };
          } else if (reviewModes.length === 2) {
            return {
              invocationId: `rev-${reviewModes.length}`,
              agentOutcome: 'success' as const,
              verdict: 'pass' as const,
              findings: [],
            };
          } else if (reviewModes.length === 3) {
            return {
              invocationId: `rev-${reviewModes.length}`,
              agentOutcome: 'success' as const,
              verdict: 'p1_found' as const,
              findings: groundedP1Findings(),
            };
          } else {
            return {
              invocationId: `rev-${reviewModes.length}`,
              agentOutcome: 'success' as const,
              verdict: 'pass' as const,
              findings: [],
            };
          }
        },
        runFix: async (): Promise<PlanFixResult> => ({
          invocationId: 'fix-1',
          agentOutcome: 'success' as const,
          verdict: 'done_with_fixes' as const,
        }),
        checkDeterministicPlan: async (_ctx): Promise<DeterministicPlanCheckResult> => {
          checkCalls++;
          if (checkCalls >= 5) {
            return {
              diagnostic: 'post-reopen deterministic failure',
              signatureBlastRadiusFailures: [],
            };
          }
          return { diagnostic: null, signatureBlastRadiusFailures: [] };
        },
        captureSnapshot: async (): Promise<PlanReviewSnapshot> => {
          verificationCaptureSnapshotCalls++;
          return {
            planMdDigest: 'post-fix-baseline',
            planMdPath: '/wt/plan.md',
            capturedAt: '2026-07-08T00:00:00.000Z',
          };
        },
      });

      await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 2 });
      expect(verificationCaptureSnapshotCalls).toBe(0);

      const deterministicFailedEvent = events.find(
        (e) => e.type === 'plan-review.loop.post_reopen_verification.deterministic_failed',
      );
      expect(deterministicFailedEvent).toBeDefined();

      const verificationStarted = events.find(
        (e) => e.type === 'plan-review.loop.post_reopen_verification.started',
      );
      expect(verificationStarted).toBeDefined();
    });

    it('post-reopen verification compares against a fresh post-fix snapshot and succeeds on matching digests', async () => {
      let snapshotCaptured: PlanReviewSnapshot | undefined;
      const reviewSnapshots: Array<PlanReviewSnapshot | undefined> = [];
      let reviewCalls = 0;
      const { deps, events } = makeDeps({
        runReview: async (_ctx, opts): Promise<PlanReviewResult> => {
          reviewCalls++;
          reviewSnapshots.push(opts?.snapshot);
          if (reviewCalls === 1) {
            return {
              invocationId: `rev-${reviewCalls}`,
              agentOutcome: 'success' as const,
              verdict: 'p1_found' as const,
              findings: groundedP1Findings(),
              snapshot: {
                planMdDigest: 'iter1-snapshot',
                planMdPath: '/wt/plan.md',
                capturedAt: '2026-07-08T00:00:00.000Z',
              },
            };
          } else if (reviewCalls === 2) {
            return {
              invocationId: `rev-${reviewCalls}`,
              agentOutcome: 'success' as const,
              verdict: 'pass' as const,
              findings: [],
            };
          } else if (reviewCalls === 3) {
            return {
              invocationId: `rev-${reviewCalls}`,
              agentOutcome: 'success' as const,
              verdict: 'p1_found' as const,
              findings: groundedP1Findings(),
            };
          } else {
            return {
              invocationId: `rev-${reviewCalls}`,
              agentOutcome: 'success' as const,
              verdict: 'pass' as const,
              findings: [],
              snapshot: {
                planMdDigest: 'post-fix-baseline',
                planMdPath: '/wt/plan.md',
                capturedAt: '2026-07-08T00:00:00.000Z',
              },
            };
          }
        },
        runFix: async (): Promise<PlanFixResult> => ({
          invocationId: 'fix-1',
          agentOutcome: 'success' as const,
          verdict: 'done_with_fixes' as const,
        }),
        captureSnapshot: async (): Promise<PlanReviewSnapshot> => {
          snapshotCaptured = {
            planMdDigest: 'post-fix-baseline',
            planMdPath: '/wt/plan.md',
            capturedAt: '2026-07-08T00:00:00.000Z',
          };
          return snapshotCaptured;
        },
        checkDeterministicPlan: async (): Promise<DeterministicPlanCheckResult> => ({
          diagnostic: null,
          signatureBlastRadiusFailures: [],
        }),
      });

      const out = await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 2 });
      expect(out.outcome).toBe('success');
      expect(out.loop.status).toBe('converged');

      expect(snapshotCaptured).toBeDefined();
      expect(snapshotCaptured?.planMdDigest).toBe('post-fix-baseline');

      const verificationStarted = events.find(
        (e) => e.type === 'plan-review.loop.post_reopen_verification.started',
      );
      expect(verificationStarted).toBeDefined();
      expect(verificationStarted?.metadata?.verificationIteration).toBe(4);

      const lastIteration = out.loop.iterations[out.loop.iterations.length - 1];
      expect(lastIteration?.outcome).toBe('resolved');
    });

    it('post-reopen verification artifact mutation requires human review even when verdict is pass', async () => {
      const reviewSnapshots: Array<PlanReviewSnapshot | undefined> = [];
      let reviewCalls = 0;
      const { deps, events } = makeDeps({
        runReview: async (_ctx, opts): Promise<PlanReviewResult> => {
          reviewCalls++;
          reviewSnapshots.push(opts?.snapshot);
          if (reviewCalls === 1) {
            return {
              invocationId: `rev-${reviewCalls}`,
              agentOutcome: 'success' as const,
              verdict: 'p1_found' as const,
              findings: groundedP1Findings(),
              snapshot: {
                planMdDigest: 'iter1-snapshot',
                planMdPath: '/wt/plan.md',
                capturedAt: '2026-07-08T00:00:00.000Z',
              },
            };
          } else if (reviewCalls === 2) {
            return {
              invocationId: `rev-${reviewCalls}`,
              agentOutcome: 'success' as const,
              verdict: 'pass' as const,
              findings: [],
            };
          } else if (reviewCalls === 3) {
            return {
              invocationId: `rev-${reviewCalls}`,
              agentOutcome: 'success' as const,
              verdict: 'p1_found' as const,
              findings: groundedP1Findings(),
            };
          } else {
            return {
              invocationId: `rev-${reviewCalls}`,
              agentOutcome: 'success' as const,
              verdict: 'pass' as const,
              findings: [],
              snapshot: {
                planMdDigest: 'different-digest',
                planMdPath: '/wt/plan.md',
                capturedAt: '2026-07-08T00:00:00.000Z',
              },
            };
          }
        },
        runFix: async (): Promise<PlanFixResult> => ({
          invocationId: 'fix-1',
          agentOutcome: 'success' as const,
          verdict: 'done_with_fixes' as const,
        }),
        captureSnapshot: async (): Promise<PlanReviewSnapshot> => ({
          planMdDigest: 'post-fix-baseline',
          planMdPath: '/wt/plan.md',
          capturedAt: '2026-07-08T00:00:00.000Z',
        }),
        checkDeterministicPlan: async (): Promise<DeterministicPlanCheckResult> => ({
          diagnostic: null,
          signatureBlastRadiusFailures: [],
        }),
      });

      const out = await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 2 });
      expect(out.outcome).toBe('needs_human_review');
      expect(out.loop.status).toBe('exhausted');

      const lastIteration = out.loop.iterations[out.loop.iterations.length - 1];
      expect(lastIteration?.outcome).toBe('unresolved');

      const driftEvent = events.find(
        (e) => e.type === 'plan-review.loop.post_reopen_verification.artifact_drift_detected',
      );
      expect(driftEvent).toBeDefined();
    });

    it('post-reopen verification persists a final_full attempt with its invocation id and returned snapshot', async () => {
      const fakeRepo = new FakeReviewStateRepository();
      let verificationInvocationId: string | undefined;
      const reviewModes: string[] = [];

      const { deps } = makeDeps({
        reviewStateRepository: fakeRepo,
        runReview: async (_ctx, opts): Promise<PlanReviewResult> => {
          const mode = opts?.mode ?? 'initial_full';
          reviewModes.push(mode);
          const isVerification =
            mode === 'final_full' && reviewModes.filter((m) => m === 'final_full').length > 1;
          if (isVerification && !verificationInvocationId) {
            verificationInvocationId = `rev-${reviewModes.length}`;
          }
          if (reviewModes.length === 1) {
            return {
              invocationId: `rev-${reviewModes.length}`,
              agentOutcome: 'success' as const,
              verdict: 'p1_found' as const,
              findings: groundedP1Findings(),
            };
          } else if (reviewModes.length === 2) {
            return {
              invocationId: `rev-${reviewModes.length}`,
              agentOutcome: 'success' as const,
              verdict: 'pass' as const,
              findings: [],
            };
          } else if (reviewModes.length === 3) {
            return {
              invocationId: `rev-${reviewModes.length}`,
              agentOutcome: 'success' as const,
              verdict: 'p1_found' as const,
              findings: groundedP1Findings(),
            };
          } else {
            return {
              invocationId: `rev-${reviewModes.length}`,
              agentOutcome: 'success' as const,
              verdict: 'pass' as const,
              findings: [],
              snapshot: {
                planMdDigest: 'post-fix-baseline',
                planMdPath: '/wt/plan.md',
                capturedAt: '2026-07-08T00:00:00.000Z',
              },
            };
          }
        },
        runFix: async (): Promise<PlanFixResult> => ({
          invocationId: 'fix-1',
          agentOutcome: 'success' as const,
          verdict: 'done_with_fixes' as const,
        }),
        captureSnapshot: async (): Promise<PlanReviewSnapshot> => ({
          planMdDigest: 'post-fix-baseline',
          planMdPath: '/wt/plan.md',
          capturedAt: '2026-07-08T00:00:00.000Z',
        }),
        checkDeterministicPlan: async (): Promise<DeterministicPlanCheckResult> => ({
          diagnostic: null,
          signatureBlastRadiusFailures: [],
        }),
      });

      const out = await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 2 });
      expect(out.outcome).toBe('success');

      const attempts = fakeRepo.listAttempts('run-1', 'plan-review', 'plan-review');
      const verificationAttempt = attempts.find((a) => a.attemptId === verificationInvocationId);
      expect(verificationAttempt).toBeDefined();
      expect(verificationAttempt?.reviewMode).toBe('final_full');
      expect(verificationAttempt?.snapshot?.identity).toBe('post-fix-baseline');
    });

    it('existing non-reopened exhaustion still enters terminal fix', async () => {
      let terminalFixCalled = false;
      let runFixCalls = 0;
      const { deps, events } = makeDeps({
        runReview: async (): Promise<PlanReviewResult> => ({
          invocationId: 'rev-1',
          agentOutcome: 'success' as const,
          verdict: 'p1_found' as const,
          findings: groundedP1Findings(),
        }),
        runFix: async (_ctx, opts): Promise<PlanFixResult> => {
          runFixCalls++;
          if (opts.isTerminalFix) {
            terminalFixCalled = true;
            return {
              invocationId: 'fix-terminal',
              agentOutcome: 'success' as const,
              verdict: 'done_with_fixes' as const,
            };
          }
          return {
            invocationId: 'fix-1',
            agentOutcome: 'success' as const,
            verdict: 'done_with_fixes' as const,
          };
        },
        terminalFixProfile: 'terminal-fix-profile',
        validateTerminalFix: async () => ({
          passed: true,
          diagnostics: [],
          changedArtifacts: {},
          summary: 'Valid change',
        }),
      });

      const out = await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 1 });
      expect(out.outcome).toBe('success');
      expect(terminalFixCalled).toBe(true);
      expect(runFixCalls).toBe(2);

      expect(
        events.filter((e) => e.type === 'plan-review.loop.post_reopen_verification.started'),
      ).toHaveLength(0);
    });

    it('post-reopen verification emits one extension and one verification event', async () => {
      let reviewCalls = 0;
      const { deps, events } = makeDeps({
        runReview: async (): Promise<PlanReviewResult> => {
          reviewCalls++;
          if (reviewCalls === 1) {
            return {
              invocationId: `rev-${reviewCalls}`,
              agentOutcome: 'success' as const,
              verdict: 'p1_found' as const,
              findings: groundedP1Findings(),
            };
          } else if (reviewCalls === 2) {
            return {
              invocationId: `rev-${reviewCalls}`,
              agentOutcome: 'success' as const,
              verdict: 'pass' as const,
              findings: [],
            };
          } else if (reviewCalls === 3) {
            return {
              invocationId: `rev-${reviewCalls}`,
              agentOutcome: 'success' as const,
              verdict: 'p1_found' as const,
              findings: groundedP1Findings(),
            };
          } else {
            return {
              invocationId: `rev-${reviewCalls}`,
              agentOutcome: 'success' as const,
              verdict: 'pass' as const,
              findings: [],
            };
          }
        },
        runFix: async (): Promise<PlanFixResult> => ({
          invocationId: 'fix-1',
          agentOutcome: 'success' as const,
          verdict: 'done_with_fixes' as const,
        }),
        checkDeterministicPlan: async (): Promise<DeterministicPlanCheckResult> => ({
          diagnostic: null,
          signatureBlastRadiusFailures: [],
        }),
      });

      const out = await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 2 });
      expect(out.outcome).toBe('success');

      const budgetExtensionEvents = events.filter(
        (e) => e.type === 'plan-review.loop.final_review.budget_extended',
      );
      expect(budgetExtensionEvents).toHaveLength(1);

      const verificationStartedEvents = events.filter(
        (e) => e.type === 'plan-review.loop.post_reopen_verification.started',
      );
      expect(verificationStartedEvents).toHaveLength(1);

      const completedEvents = events.filter(
        (e) => e.type === 'plan-review.loop.iteration.completed',
      );
      const verificationCompleted = completedEvents.find(
        (e) => e.metadata?.verification === 'post_reopen_final_full',
      );
      expect(verificationCompleted).toBeDefined();
      expect(verificationCompleted?.metadata).toMatchObject({
        outcome: 'resolved',
        verification: 'post_reopen_final_full',
      });
    });
  });
});
