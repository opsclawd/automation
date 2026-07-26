import { describe, it, expect } from 'vitest';
import { RunId, PhaseName, AgentProfileName } from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { CONTRACT_VIOLATION_CODES } from '../../ports/contract-violation-codes.js';
import { FakeLoopRepository } from '../../test-doubles/fake-loop-repository.js';
import { ReviewFixLoop } from '../review-fix-loop.js';
import type {
  ReviewFixLoopDeps,
  ReviewStepResult,
  ReviewStepOptions,
  StepContext,
} from '../types.js';

function collectEvents() {
  const events: Array<{
    type: string;
    level: string;
    message: string;
    metadata: Record<string, unknown>;
  }> = [];
  const bus = {
    publish: (_runUuid: string, e: OrchestratorEvent) =>
      events.push({
        type: e.type,
        level: e.level,
        message: e.message,
        metadata: (e.metadata as Record<string, unknown>) ?? {},
      }),
    subscribe: () => () => {},
  };
  return { events, bus };
}

function makeDeps(reviewSequence: ReviewStepResult[]) {
  const { events, bus } = collectEvents();
  const loopRepo = new FakeLoopRepository();
  const reviewCalls: Array<{ ctx: StepContext; opts?: ReviewStepOptions }> = [];
  let reviewIdx = 0;

  const deps: ReviewFixLoopDeps = {
    runPostFixGate: async () => ({ outcome: 'pass', output: '' }),
    runReview: async (ctx, opts) => {
      reviewCalls.push({ ctx, opts });
      const res = reviewSequence[reviewIdx++];
      if (!res) throw new Error(`Unexpected review call ${reviewIdx}`);
      return res;
    },
    runFix: async () => ({
      invocationId: 'fix-1',
      agentOutcome: 'success',
      verdict: 'done_with_fixes',
    }),
    runRevalidation: async () => ({ validationRunId: 'val-1', passed: true }),
    loops: loopRepo,
    events: bus,
    now: () => new Date('2026-01-01T00:00:00Z'),
    idFactory: () => 'loop-1',
    cleanArtifacts: async () => {},
  };

  return { deps, loopRepo, reviewCalls, events };
}

function baseInput() {
  return {
    runId: RunId('run-1'),
    phaseId: PhaseName('whole-pr-review'),
    repoId: 'owner/repo',
    cwd: '/wt',
    maxIterations: 3,
    reviewProfile: AgentProfileName('reviewer'),
    fixProfile: AgentProfileName('fixer'),
  };
}

describe('ReviewFixLoop serialization artifact retry', () => {
  it('retries a serialization artifact failure once in the same review loop iteration', async () => {
    const { deps, loopRepo, reviewCalls, events } = makeDeps([
      {
        invocationId: 'review-primary',
        agentOutcome: 'contract_violation',
        failureClassification: 'serialization_artifact',
        violationCode: CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT,
      },
      {
        invocationId: 'review-retry',
        agentOutcome: 'success',
        verdict: 'pass',
      },
    ]);

    const loop = new ReviewFixLoop(deps);
    const result = await loop.execute(baseInput());

    expect(result.phaseOutcome).toBe('passed');
    expect(result.loopStatus).toBe('converged');
    expect(reviewCalls).toHaveLength(2);
    expect(reviewCalls[0].opts?.artifactRecoveryRetry).toBeUndefined();
    expect(reviewCalls[1].opts?.artifactRecoveryRetry).toBe(true);

    const persistedLoop = loopRepo.findById('loop-1');
    expect(persistedLoop?.iterations).toHaveLength(1);
    expect(persistedLoop?.iterations[0].reviewInvocationId).toBe('review-retry');

    const retryEvent = events.find((e) => e.type === 'review.artifact_recovery_retry');
    expect(retryEvent).toBeDefined();
    expect(retryEvent?.metadata.previousInvocationId).toBe('review-primary');
    expect(retryEvent?.metadata.violationCode).toBe(
      CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT,
    );
  });

  it('does not retry an unrecoverable artifact failure', async () => {
    const { deps, loopRepo, reviewCalls } = makeDeps([
      {
        invocationId: 'review-primary',
        agentOutcome: 'contract_violation',
        failureClassification: 'unrecoverable_artifact',
        violationCode: CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT,
      },
    ]);

    const loop = new ReviewFixLoop(deps);
    const result = await loop.execute(baseInput());

    expect(result.phaseOutcome).toBe('failed');
    expect(result.loopStatus).toBe('failed');
    expect(reviewCalls).toHaveLength(1);

    const persistedLoop = loopRepo.findById('loop-1');
    expect(persistedLoop?.iterations).toHaveLength(1);
  });

  it('fails after the serialization artifact retry also fails', async () => {
    const { deps, loopRepo, reviewCalls } = makeDeps([
      {
        invocationId: 'review-primary',
        agentOutcome: 'contract_violation',
        failureClassification: 'serialization_artifact',
        violationCode: CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT,
      },
      {
        invocationId: 'review-retry',
        agentOutcome: 'contract_violation',
        failureClassification: 'serialization_artifact',
        violationCode: CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT,
      },
    ]);

    const loop = new ReviewFixLoop(deps);
    const result = await loop.execute(baseInput());

    expect(result.phaseOutcome).toBe('failed');
    expect(result.loopStatus).toBe('failed');
    expect(reviewCalls).toHaveLength(2);

    const persistedLoop = loopRepo.findById('loop-1');
    expect(persistedLoop?.iterations).toHaveLength(1);
    expect(persistedLoop?.iterations[0].reviewInvocationId).toBe('review-retry');
  });

  it('marks the second reviewer invocation as an artifact recovery semantic retry', async () => {
    const { deps, reviewCalls } = makeDeps([
      {
        invocationId: 'review-primary',
        agentOutcome: 'contract_violation',
        failureClassification: 'serialization_artifact',
        violationCode: CONTRACT_VIOLATION_CODES.INVALID_RESULT_JSON,
      },
      {
        invocationId: 'review-retry',
        agentOutcome: 'success',
        verdict: 'pass',
      },
    ]);

    const loop = new ReviewFixLoop(deps);
    await loop.execute(baseInput());

    expect(reviewCalls).toHaveLength(2);
    expect(reviewCalls[0].opts?.artifactRecoveryRetry).not.toBe(true);
    expect(reviewCalls[1].opts?.artifactRecoveryRetry).toBe(true);
  });

  it('does not spend another configured loop iteration on the artifact recovery retry', async () => {
    const { deps, loopRepo } = makeDeps([
      {
        invocationId: 'review-primary',
        agentOutcome: 'contract_violation',
        failureClassification: 'serialization_artifact',
        violationCode: CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT,
      },
      {
        invocationId: 'review-retry',
        agentOutcome: 'success',
        verdict: 'pass',
      },
    ]);

    const loop = new ReviewFixLoop(deps);
    const result = await loop.execute({ ...baseInput(), maxIterations: 1 });

    expect(result.phaseOutcome).toBe('passed');
    const persistedLoop = loopRepo.findById('loop-1');
    expect(persistedLoop?.iterations).toHaveLength(1);
  });
});
