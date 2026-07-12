import { describe, it, expect } from 'vitest';
import { RunId, PhaseName, AgentProfileName } from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { FakeLoopRepository } from '../../test-doubles/fake-loop-repository.js';
import { FakeReviewStateRepository } from '../../test-doubles/fake-review-state-repository.js';
import { ReviewFixLoop } from '../review-fix-loop.js';
import { fingerprintFinding } from '../../review-state/fingerprint.js';
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
    maxIterations: 3,
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
      verdict: 'pass',
      reviewedCommitSha: 'sha-1',
    }),
    runFix: async (): Promise<FixStepResult> => ({
      invocationId: 'fix',
      agentOutcome: 'success',
      verdict: 'done_with_fixes',
    }),
    runRevalidation: async (): Promise<RevalidationResult> => ({
      validationRunId: 'val',
      passed: true,
    }),
    loops: new FakeLoopRepository(),
    events: bus,
    now: () => new Date('2026-06-14T00:00:00.000Z'),
    idFactory: () => 'loop-1',
    reviewStateRepository: new FakeReviewStateRepository(),
    ...over,
  };
}

describe('ReviewFixLoop integration mode tests', () => {
  it('records integration mode initial_full review mode on iteration 1 and intermediate_delta on subsequent iterations', async () => {
    const fakeRepo = new FakeReviewStateRepository();
    const modesObserved: string[] = [];

    const deps = makeDeps({
      reviewStateRepository: fakeRepo,
      runReview: async (ctx, opts) => {
        if (opts && opts.mode) {
          modesObserved.push(opts.mode);
        }
        return {
          invocationId: 'rev-' + ctx.iterationIndex,
          agentOutcome: 'success',
          verdict: ctx.iterationIndex === 1 ? 'fail' : 'pass',
          reviewedCommitSha: 'sha-' + ctx.iterationIndex,
          offendingFindings:
            ctx.iterationIndex === 1 ? [{ severity: 'critical', summary: 'Wiring mismatch' }] : [],
        };
      },
      runFix: async () => ({
        invocationId: 'fix-1',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
        headBeforeFix: 'sha-1',
      }),
    });

    const result = await new ReviewFixLoop(deps).execute(baseInput());

    expect(result.phaseOutcome).toBe('passed');
    expect(modesObserved).toEqual(['integration_full', 'intermediate_delta']);

    // Check attempts in the repository
    const attempts = fakeRepo.listAttempts('run-1', 'whole-pr-review', 'whole-pr-review');
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.reviewMode).toBe('integration_full');
    expect(attempts[0]?.snapshot?.identity).toBe('sha-1');
    expect(attempts[1]?.reviewMode).toBe('intermediate_delta');
    expect(attempts[1]?.snapshot?.identity).toBe('sha-2');

    // Check state persistence
    const states = fakeRepo.listDimensionStates('run-1', 'whole-pr-review', 'whole-pr-review');
    const integrationState = states.find((s) => s.dimension === 'integration');
    expect(integrationState).toBeDefined();
    expect(integrationState?.latestVerdict).toBe('pass');
    expect(integrationState?.dirty).toBe(false);
  });

  it('correctly transitions dispositions (open -> addressed/rebutted -> recurred) based on fixer verdict', async () => {
    const fakeRepo = new FakeReviewStateRepository();
    let iter = 0;

    const deps = makeDeps({
      reviewStateRepository: fakeRepo,
      runReview: async (_ctx, _opts) => {
        iter++;
        return {
          invocationId: 'rev-' + iter,
          agentOutcome: 'success',
          verdict: iter === 3 ? 'pass' : 'fail',
          reviewedCommitSha: 'sha-' + iter,
          offendingFindings:
            iter === 1
              ? [{ severity: 'high', summary: 'Abc' }]
              : iter === 2
                ? [{ severity: 'high', summary: 'Abc' }]
                : [],
        };
      },
      runFix: async (ctx) => {
        return {
          invocationId: 'fix-' + ctx.iterationIndex,
          agentOutcome: 'success',
          verdict: ctx.iterationIndex === 1 ? 'done_no_fixes_needed' : 'done_with_fixes',
          headBeforeFix: 'sha-' + ctx.iterationIndex,
        };
      },
    });

    const result = await new ReviewFixLoop(deps).execute({ ...baseInput(), maxIterations: 5 });
    expect(result.phaseOutcome).toBe('passed');

    const states = fakeRepo.listDimensionStates('run-1', 'whole-pr-review', 'whole-pr-review');
    const integrationState = states.find((s) => s.dimension === 'integration');
    expect(integrationState).toBeDefined();

    // Disposition history:
    // iter 1: 'Abc' is open.
    // iter 2: fixer returned done_no_fixes_needed. 'Abc' recurred (rebutted -> recurred).
    // iter 3: fixer returned done_with_fixes. 'Abc' is addressed (resolved).
    const expectedFp = await fingerprintFinding('integration', 'high', 'Abc');
    const abcHistory = integrationState?.dispositionHistory.filter(
      (h) => h.fingerprint === expectedFp,
    );
    expect(abcHistory).toBeDefined();
    expect(abcHistory?.map((h) => h.disposition)).toEqual(['open', 'recurred', 'addressed']);
  });

  it('escalates to human review when arbiter returns insufficient_evidence or ambiguous', async () => {
    const fakeRepo = new FakeReviewStateRepository();
    const deps = makeDeps({
      reviewStateRepository: fakeRepo,
      runReview: async () => ({
        invocationId: 'rev-1',
        agentOutcome: 'success',
        verdict: 'fail',
        reviewedCommitSha: 'sha-1',
        offendingFindings: [{ severity: 'high', summary: 'Abc' }],
      }),
      runFix: async () => ({
        invocationId: 'fix-1',
        agentOutcome: 'success',
        verdict: 'done_no_fixes_needed',
        headBeforeFix: 'sha-1',
      }),
      runArbiter: async () => ({
        outcome: 'insufficient_evidence',
        evidence: '',
        rationale: 'I cannot tell',
      }),
    });

    const result = await new ReviewFixLoop(deps).execute(baseInput());
    expect(result.phaseOutcome).toBe('failed');
    expect(result.needsHumanReview).toBe(true);
  });
});
