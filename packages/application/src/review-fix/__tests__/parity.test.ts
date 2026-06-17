import { describe, it, expect } from 'vitest';
import { RunId, PhaseName, AgentProfileName } from '@ai-sdlc/domain';
import { ReviewFixLoop } from '../review-fix-loop.js';
import { FakeLoopRepository } from '../../test-doubles/fake-loop-repository.js';
import type {
  ReviewFixLoopDeps,
  ReviewStepResult,
  FixStepResult,
  RevalidationResult,
} from '../types.js';

/**
 * Parity characterization tests for #374: bidirectional severity gate.
 *
 * Invariant: readReviewVerdict overrides a fail verdict to pass when every
 * finding in the review has a known severity strictly below blockOnSeverity.
 * This allows the review/fix loop to converge on iterations that would
 * otherwise churn on cosmetic-only findings. Without this gate, the loop
 * runs maxIterations and fails the phase on functionally-green code
 * (false negative).
 *
 * These tests run against the TS ReviewFixLoop with test doubles — they
 * verify the loop-level behavioral contract the orchestrator depends on.
 */
describe('parity[#374]: bidirectional severity gate', () => {
  function makeDeps(over: Partial<ReviewFixLoopDeps>): ReviewFixLoopDeps {
    let n = 0;
    return {
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
      events: { publish: () => {}, subscribe: () => () => {} },
      now: () => new Date('2026-06-14T00:00:00.000Z'),
      idFactory: () => 'parity-loop',
      ...over,
    };
  }

  function baseInput() {
    return {
      runId: RunId('run-parity'),
      phaseId: PhaseName('whole-pr-review'),
      repoId: 'owner/repo',
      cwd: '/wt',
      maxIterations: 3,
      blockOnSeverity: 'high',
      reviewProfile: AgentProfileName('opencode-frontier'),
      fixProfile: AgentProfileName('pi-qwen-local'),
    };
  }

  it('a fail verdict with only sub-threshold findings converges to pass', async () => {
    let reviewCalls = 0;
    const deps = makeDeps({
      runReview: async () => {
        reviewCalls += 1;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success',
          verdict: reviewCalls === 1 ? 'pass' : 'pass',
          overridden: reviewCalls === 1 ? true : undefined,
          offendingFindings: reviewCalls === 1 ? [] : undefined,
        };
      },
    });
    const out = await new ReviewFixLoop(deps).execute(baseInput());
    expect(out.phaseOutcome).toBe('passed');
    expect(out.loop.status).toBe('converged');
    expect(out.loop.iterations).toHaveLength(1);
  });
});
