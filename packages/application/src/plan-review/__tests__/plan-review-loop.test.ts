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

  it('AC #5.2 — fix then pass', async () => {
    let reviewCalls = 0;
    const { deps } = makeDeps({
      runReview: async (): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: reviewCalls === 1 ? ('p1_found' as const) : ('pass' as const),
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
    const { deps } = makeDeps({
      runReview: async (): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: reviewCalls === 3 ? ('pass' as const) : ('p1_found' as const),
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
    expect(out.outcome).toBe('success');
    expect(out.loop.status).toBe('converged');
    expect(out.loop.iterations).toHaveLength(3);
    expect(out.loop.iterations[0]?.outcome).toBe('fixed');
    expect(out.loop.iterations[1]?.outcome).toBe('fixed');
    expect(out.loop.iterations[2]?.outcome).toBe('resolved');
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
    const { deps } = makeDeps({
      runReview: async (): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: 'p1_found' as const,
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
});
