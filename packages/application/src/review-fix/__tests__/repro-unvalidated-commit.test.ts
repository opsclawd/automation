import { describe, it, expect } from 'vitest';
import { RunId, PhaseName, AgentProfileName } from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import type { GitPort } from '../../ports/git-port.js';
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

function makeFakeGitPort(opts: {
  headSha: string;
  statusOutput?: string;
}): GitPort {
  let currentHead = opts.headSha;
  let currentStatus = opts.statusOutput ?? '';
  return {
    createWorktree: async () => undefined,
    removeWorktree: async () => undefined,
    currentBranch: async () => 'main',
    headCommitSha: async () => currentHead,
    resetHard: async () => undefined,
    diff: async () => '',
    diffStat: async () => '',
    addAll: async () => { currentStatus = ''; },
    commit: async () => {
        currentHead = 'sha-after-commit';
        return currentHead;
    },
    push: async () => undefined,
    remoteRef: async () => undefined,
    isAncestor: async () => true,
    logBetween: async () => [],
    cleanUntracked: async () => undefined,
    headCommitShaOf: async () => undefined,
    status: async () => currentStatus,
    resetWorktreeIfClean: async () => undefined,
  };
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
    fixFallbackProfile: AgentProfileName('opencode-frontier'),
  };
}

describe('ReviewFixLoop Regression (unvalidated final commit)', () => {
  it('re-validates the final commit even if previous revalidation passed (auto-commit case)', async () => {
    const { bus } = collectEvents();
    const git = makeFakeGitPort({ headSha: 'sha-1', statusOutput: 'M file.ts' });

    let revalCalls = 0;
    let reviewCalls = 0;

    const deps: ReviewFixLoopDeps = {
      runPostFixGate: async (): Promise<PostFixGateResult> => ({ outcome: 'pass', output: '' }),
      runReview: async (): Promise<ReviewStepResult> => {
        reviewCalls++;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success',
          // First review fails, second (trailing) review passes
          verdict: reviewCalls === 1 ? 'fail' : 'pass',
        };
      },
      runFix: async (): Promise<FixStepResult> => ({
        invocationId: 'fix-1',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
        headBeforeFix: 'sha-1', // Claims it committed but it didn't (triggering auto-commit)
      }),
      runRevalidation: async (): Promise<RevalidationResult> => {
        revalCalls++;
        return {
          validationRunId: `val-${revalCalls}`,
          passed: true,
        };
      },
      loops: new FakeLoopRepository(),
      events: bus,
      now: () => new Date(),
      idFactory: () => 'loop-1',
      git,
    };

    const loop = new ReviewFixLoop(deps);
    await loop.execute(baseInput());

    // Expectation:
    // 1. Iteration 1: Review Fail -> Fix (claims done but dirty) -> runRevalidation (1) -> auto-commit -> fixed.
    // 2. Iteration 2 (trailing): Review Pass.
    // SHOULD trigger runRevalidation (2) because HEAD advanced since last revalidation.

    expect(revalCalls).toBe(2);
  });
});
