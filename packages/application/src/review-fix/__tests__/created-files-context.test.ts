import { describe, it, expect } from 'vitest';
import { RunId, PhaseName, AgentProfileName } from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import type { EventBusPort } from '../../ports/event-bus-port.js';
import { CONTRACT_VIOLATION_CODES } from '../../ports/contract-violation-codes.js';
import { FakeGitPort } from '../../test-doubles/fake-git-port.js';
import { FakeLoopRepository } from '../../test-doubles/fake-loop-repository.js';
import { ReviewFixLoop } from '../review-fix-loop.js';
import type {
  ReviewFixLoopDeps,
  ReviewFixLoopInput,
  ReviewStepResult,
  ReviewStepOptions,
  StepContext,
  FixStepOptions,
  FixStepResult,
} from '../types.js';

type GitWithCreatedFiles = FakeGitPort & {
  createdFiles(cwd: string, base: string, head?: string): Promise<string[]>;
};
type OptionsWithCreatedFiles = ReviewStepOptions & { createdFiles?: string[] };

function baseInput(overrides?: Partial<ReviewFixLoopInput>): ReviewFixLoopInput {
  return {
    runId: RunId('run-1'),
    phaseId: PhaseName('review-fix'),
    repoId: 'owner/repo',
    cwd: '/wt',
    maxIterations: 2,
    reviewProfile: AgentProfileName('reviewer'),
    fixProfile: AgentProfileName('fixer'),
    baselineCommitSha: 'base-sha-123',
    ...overrides,
  };
}

function collectEvents() {
  const events: OrchestratorEvent[] = [];
  const bus: EventBusPort = {
    publish: (_runUuid: string, e: OrchestratorEvent) => events.push(e),
    subscribe: () => () => {},
  };
  return { events, bus };
}

describe('ReviewFixLoop created-files context', () => {
  it('passes branch-created file paths to every review before the first reviewer invocation', async () => {
    const { bus } = collectEvents();
    const git = new FakeGitPort() as GitWithCreatedFiles;
    git.headByCwd.set('/wt', 'head-sha-456');

    const createdFilesCalls: Array<{ cwd: string; base: string; head?: string }> = [];
    git.createdFiles = async (cwd: string, base: string, head?: string) => {
      createdFilesCalls.push({ cwd, base, head });
      return ['vitest.integration.config.ts', 'src/new-file.ts'];
    };

    const reviewCalls: Array<{ ctx: StepContext; opts?: OptionsWithCreatedFiles }> = [];
    let reviewCount = 0;
    const runReview = async (
      ctx: StepContext,
      opts?: ReviewStepOptions,
    ): Promise<ReviewStepResult> => {
      reviewCalls.push({ ctx, opts: opts as OptionsWithCreatedFiles });
      reviewCount++;
      if (reviewCount === 1) {
        return {
          invocationId: 'rev-1',
          agentOutcome: 'contract_violation',
          classification: 'serialization_artifact',
          violationCode: CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT,
        };
      }
      return {
        invocationId: 'rev-2',
        agentOutcome: 'success',
        verdict: 'pass',
      };
    };

    const fixCalls: Array<{ ctx: StepContext; opts: FixStepOptions }> = [];
    const runFix = async (ctx: StepContext, opts: FixStepOptions): Promise<FixStepResult> => {
      fixCalls.push({ ctx, opts });
      return {
        invocationId: 'fix-1',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
      };
    };

    const loops = new FakeLoopRepository();
    const deps: ReviewFixLoopDeps = {
      runPostFixGate: async () => ({ outcome: 'pass', output: '' }),
      runReview,
      runFix,
      runRevalidation: async () => ({ validationRunId: 'val-1', passed: true }),
      loops,
      events: bus,
      now: () => new Date('2026-01-01T00:00:00Z'),
      idFactory: () => 'loop-1',
      cleanArtifacts: async () => {},
      git,
    };

    const loop = new ReviewFixLoop(deps);
    const result = await loop.execute(baseInput());

    expect(createdFilesCalls).toHaveLength(1);
    expect(createdFilesCalls[0]).toEqual({ cwd: '/wt', base: 'base-sha-123', head: 'HEAD' });
    expect(reviewCalls).toHaveLength(2);
    expect(reviewCalls[0].opts?.createdFiles).toEqual([
      'src/new-file.ts',
      'vitest.integration.config.ts',
    ]);
    expect(reviewCalls[1].opts?.createdFiles).toEqual([
      'src/new-file.ts',
      'vitest.integration.config.ts',
    ]);
    expect(reviewCalls[1].opts?.artifactRecoveryRetry).toBe(true);
    expect(result.phaseOutcome).toBe('passed');
    expect(result.loopStatus).toBe('converged');
  });

  it('fails closed when branch-created file discovery fails', async () => {
    const { events, bus } = collectEvents();
    const git = new FakeGitPort() as GitWithCreatedFiles;
    git.headByCwd.set('/wt', 'head-sha-456');

    git.createdFiles = async () => {
      throw new Error('git diff failed');
    };

    const reviewCalls: Array<{ ctx: StepContext; opts?: OptionsWithCreatedFiles }> = [];
    const runReview = async (
      ctx: StepContext,
      opts?: ReviewStepOptions,
    ): Promise<ReviewStepResult> => {
      reviewCalls.push({ ctx, opts: opts as OptionsWithCreatedFiles });
      return {
        invocationId: 'rev-1',
        agentOutcome: 'success',
        verdict: 'pass',
      };
    };

    const fixCalls: Array<{ ctx: StepContext; opts: FixStepOptions }> = [];
    const runFix = async (ctx: StepContext, opts: FixStepOptions): Promise<FixStepResult> => {
      fixCalls.push({ ctx, opts });
      return {
        invocationId: 'fix-1',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
      };
    };

    const loops = new FakeLoopRepository();
    const deps: ReviewFixLoopDeps = {
      runPostFixGate: async () => ({ outcome: 'pass', output: '' }),
      runReview,
      runFix,
      runRevalidation: async () => ({ validationRunId: 'val-1', passed: true }),
      loops,
      events: bus,
      now: () => new Date('2026-01-01T00:00:00Z'),
      idFactory: () => 'loop-1',
      cleanArtifacts: async () => {},
      git,
    };

    const loop = new ReviewFixLoop(deps);
    const result = await loop.execute(baseInput());

    expect(reviewCalls).toHaveLength(0);
    expect(fixCalls).toHaveLength(0);
    expect(result.phaseOutcome).toBe('failed');
    expect(result.loopStatus).toBe('failed');
    expect(result.needsHumanReview).toBe(true);
    expect(events.some((event) => event.type === 'loop.created_files_check_failed')).toBe(true);
  });
});
