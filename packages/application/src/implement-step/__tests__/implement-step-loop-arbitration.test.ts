import { describe, it, expect } from 'vitest';
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
  TypecheckResult,
  ArbiterResult,
} from '../types.js';
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
    runSpecReview: async (): Promise<SpecReviewResult> => ({
      invocationId: `sr-${++n}`,
      agentOutcome: 'success',
      verdict: 'pass',
    }),
    runQualityReview: async (): Promise<QualityReviewResult> => ({
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
    fixProfile: AgentProfileName('test-fix-profile'),
    fixFallbackProfile: AgentProfileName('test-fallback-profile'),
    now: () => new Date('2026-06-17T00:00:00.000Z'),
    idFactory: () => 'loop-1',
    ...over,
  };
}

describe('ImplementStepLoop Arbitration Integration', () => {
  it('calls runArbiter when 1-shot re-run fails and arbiter is configured', async () => {
    const { bus, events } = collectEvents();
    let arbiterCalls = 0;
    const deps = makeDeps({
      events: bus,
      runSpecReview: async () => ({
        invocationId: 'sr-1',
        agentOutcome: 'success' as const,
        verdict: 'fail' as const,
      }),
      runFix: async () => ({
        invocationId: 'fix-1',
        agentOutcome: 'success' as const,
        verdict: 'done_no_fixes_needed' as const,
        rebuttal: 'I disagree with the reviewer.',
      }),
      runArbiter: async (): Promise<ArbiterResult> => {
        arbiterCalls += 1;
        return {
          outcome: 'finding_invalid',
          evidence: 'Code is correct.',
          rationale: 'Reviewer missed the context.',
        };
      },
    });

    const out = await new ImplementStepLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('success');
    expect(arbiterCalls).toBe(1);
    expect(events.some(e => e.type === 'review.contradiction.escalated')).toBe(true);
    expect(events.some(e => e.type === 'review.contradiction.resolved' && e.metadata.ruling === 'finding_invalid')).toBe(true);
  });

  it('escalates to human review if arbiter returns empty evidence', async () => {
    const { bus, events } = collectEvents();
    const deps = makeDeps({
      events: bus,
      runSpecReview: async () => ({
        invocationId: 'sr-1',
        agentOutcome: 'success' as const,
        verdict: 'fail' as const,
      }),
      runFix: async () => ({
        invocationId: 'fix-1',
        agentOutcome: 'success' as const,
        verdict: 'done_no_fixes_needed' as const,
        rebuttal: 'I disagree.',
      }),
      runArbiter: async (): Promise<ArbiterResult> => ({
        outcome: 'finding_invalid',
        evidence: '', // Empty evidence!
        rationale: 'No reason.',
      }),
    });

    const out = await new ImplementStepLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('needs_human_review');
    expect(events.some(e => e.type === 'needs_human_review' && e.message.includes('empty evidence'))).toBe(true);
  });

  it('carries arbiter rationale into next fix call if finding_valid', async () => {
    const { bus } = collectEvents();
    let fixCalls = 0;
    let capturedReconciliationContext: string | undefined;

    const deps = makeDeps({
      events: bus,
      runSpecReview: async () => ({
        invocationId: 'sr-1',
        agentOutcome: 'success' as const,
        verdict: fixCalls >= 2 ? 'pass' as const : 'fail' as const,
      }),
      runFix: async (_ctx, opts) => {
        fixCalls += 1;
        if (fixCalls === 2) {
          capturedReconciliationContext = opts.reconciliationContext;
        }
        return {
          invocationId: `fix-${fixCalls}`,
          agentOutcome: 'success' as const,
          verdict: fixCalls === 1 ? 'done_no_fixes_needed' as const : 'done_with_fixes' as const,
          rebuttal: fixCalls === 1 ? 'Disagree.' : undefined,
        };
      },
      runArbiter: async (): Promise<ArbiterResult> => ({
        outcome: 'finding_valid',
        evidence: 'Reviewer is right.',
        rationale: 'The fix is actually required.',
      }),
    });

    await new ImplementStepLoop(deps).execute({ ...baseInput(), maxIterations: 5 });
    expect(fixCalls).toBeGreaterThanOrEqual(2);
    expect(capturedReconciliationContext).toBe('The fix is actually required.');
  });
});
