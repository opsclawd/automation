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
    maxIterations: 20,
    reviewProfile: AgentProfileName('opencode-frontier'),
    fixProfile: AgentProfileName('pi-qwen-local'),
  };
}

function makeDeps(over: Partial<ReviewFixLoopDeps>): ReviewFixLoopDeps {
  const { bus } = collectEvents();
  return {
    runPostFixGate: async (): Promise<PostFixGateResult> => ({
      outcome: 'pass',
      output: '',
    }),
    runReview: async (): Promise<ReviewStepResult> => ({
      invocationId: 'rev',
      agentOutcome: 'success',
      verdict: 'fail',
    }),
    runFix: async (): Promise<FixStepResult> => ({
      invocationId: 'fix',
      agentOutcome: 'success',
      verdict: 'cannot_fix',
    }),
    runRevalidation: async (): Promise<RevalidationResult> => ({
      validationRunId: 'val',
      passed: true,
    }),
    loops: new FakeLoopRepository(),
    events: bus,
    now: () => new Date('2026-06-14T00:00:00.000Z'),
    idFactory: () => 'loop-1',
    ...over,
  };
}

describe('ReviewFixLoop — runaway-protection caps (#667)', () => {
  it('exits as exhausted with needsHumanReview when maxConsecutiveFixFailures is hit', async () => {
    const { events, bus } = collectEvents();
    let fixCalls = 0;
    const deps = makeDeps({
      events: bus,
      runReview: async () => ({
        invocationId: 'r',
        agentOutcome: 'success',
        verdict: 'fail',
      }),
      runFix: async () => {
        fixCalls += 1;
        return {
          invocationId: `fix-${fixCalls}`,
          agentOutcome: 'success',
          verdict: 'cannot_fix',
        };
      },
    });
    const out = await new ReviewFixLoop(deps).execute({
      ...baseInput(),
      maxConsecutiveFixFailures: 3,
    });

    expect(out.loopStatus).toBe('exhausted');
    expect(out.needsHumanReview).toBe(true);
    expect(out.phaseOutcome).toBe('failed');
    expect(fixCalls).toBe(3);
    expect(events.some((e) => e.type === 'loop.exhausted.fix_consecutive_failures')).toBe(true);
  });

  it('exits as exhausted when maxTotalFixAttempts is hit', async () => {
    const { events, bus } = collectEvents();
    let iteration = 0;
    const deps = makeDeps({
      events: bus,
      runReview: async () => {
        iteration += 1;
        return {
          invocationId: `rev-${iteration}`,
          agentOutcome: 'success',
          verdict: 'fail',
        };
      },
      runFix: async () => ({
        invocationId: 'fix',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
      }),
      runRevalidation: async () => ({
        validationRunId: 'val',
        passed: true,
      }),
    });
    const out = await new ReviewFixLoop(deps).execute({
      ...baseInput(),
      maxTotalFixAttempts: 5,
    });

    expect(out.loopStatus).toBe('exhausted');
    expect(out.phaseOutcome).toBe('failed');
    expect(events.some((e) => e.type === 'loop.exhausted.fix_attempt_cap')).toBe(true);
  });

  it('does not exit early when neither cap is set (regression: behaviour unchanged)', async () => {
    let reviewCalls = 0;
    const deps = makeDeps({
      runReview: async () => {
        reviewCalls += 1;
        // Always return pass so the loop converges on iteration 1 — no caps
        // engaged. The assertion is that the loop completes the same way it
        // does without the new fields.
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success',
          verdict: 'pass',
        };
      },
    });
    const out = await new ReviewFixLoop(deps).execute(baseInput());
    expect(out.loopStatus).toBe('converged');
    expect(out.phaseOutcome).toBe('passed');
    expect(reviewCalls).toBe(1);
  });
});
