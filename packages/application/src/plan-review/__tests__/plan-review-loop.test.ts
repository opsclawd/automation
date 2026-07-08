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

function makeDeps(over: Partial<PlanReviewLoopDeps>): PlanReviewLoopDeps {
  let n = 0;
  const { bus } = collectEvents();
  return {
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
}

describe('PlanReviewLoop', () => {
  it('AC #5.1 — pass on first review', async () => {
    const deps = makeDeps({});
    const out = await new PlanReviewLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('success');
    expect(out.loop.status).toBe('converged');
    expect(out.loop.iterations).toHaveLength(1);
    expect(out.loop.iterations[0]?.outcome).toBe('resolved');
    expect(out.proceedWithConcerns).toBe(false);
  });

  it('AC #5.2 — fix then pass', async () => {
    let reviewCalls = 0;
    const deps = makeDeps({
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
    const deps = makeDeps({
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
    const deps = makeDeps({
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
    const deps = makeDeps({
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

  it('parity #297 — reviewer retries on agent failure then converges', async () => {
    let reviewCalls = 0;
    const deps = makeDeps({
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
