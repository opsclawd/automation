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
    phaseId: PhaseName('implement'),
    repoId: 'owner/repo',
    cwd: '/wt',
    stepIndex: 1,
    stepTitle: 'Add login page',
    maxIterations: 3,
    implementProfile: AgentProfileName('opencode-frontier'),
    specReviewProfile: AgentProfileName('opencode-frontier'),
    qualityReviewProfile: AgentProfileName('pi-qwen-local'),
    fixProfile: AgentProfileName('pi-qwen-local'),
    fixFallbackProfile: AgentProfileName('opencode-frontier'),
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
      runSpecReview: async () => {
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
      runQualityReview: async () => {
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
      runSpecReview: async () => {
        specReviewCalls += 1;
        return {
          invocationId: `sr-${specReviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: specReviewCalls === 1 ? ('fail' as const) : ('pass' as const),
        };
      },
      runQualityReview: async () => {
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
});
