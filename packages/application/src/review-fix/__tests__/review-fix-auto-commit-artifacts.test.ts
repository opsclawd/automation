import { describe, it, expect } from 'vitest';
import { RunId, PhaseName, AgentProfileName } from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import type { GitPort } from '../../ports/git-port.js';
import type { LoopRepositoryPort } from '../../ports/loop-repository-port.js';
import { ReviewFixLoop } from '../review-fix-loop.js';
import type {
  ReviewFixLoopDeps,
  ReviewStepResult,
  FixStepResult,
  RevalidationResult,
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

function makeFakeGit(opts: { headSha: string; statusOutput: string }): {
  git: GitPort;
  addCalls: Array<{ cwd: string; files: string[] }>;
  addAllCalls: string[];
} {
  const addCalls: Array<{ cwd: string; files: string[] }> = [];
  const addAllCalls: string[] = [];
  const git: GitPort = {
    createWorktree: async () => undefined,
    removeWorktree: async () => undefined,
    currentBranch: async () => 'main',
    headCommitSha: async () => opts.headSha,
    resetHard: async () => undefined,
    diff: async () => '',
    diffStat: async () => '',
    add: async (cwd, files) => {
      addCalls.push({ cwd, files: [...files] });
    },
    addAll: async (cwd) => {
      addAllCalls.push(cwd);
    },
    commit: async () => 'sha-autocommit',
    push: async () => undefined,
    remoteRef: async () => undefined,
    isAncestor: async () => true,
    logBetween: async () => [],
    cleanUntracked: async () => undefined,
    headCommitShaOf: async () => undefined,
    status: async () => opts.statusOutput,
    resetWorktreeIfClean: async () => undefined,
  };
  return { git, addCalls, addAllCalls };
}

describe('ReviewFixLoop auto-commit artifact exclusion', () => {
  it('calls git.add with dirtySourcePaths and never git.addAll when auto-committing uncommitted changes', async () => {
    const { events, bus } = collectEvents();
    const { git, addCalls, addAllCalls } = makeFakeGit({
      headSha: 'sha-pre',
      statusOutput: ' M packages/application/src/fix.ts\n?? design.md\n?? task-manifest.json\n',
    });

    const deps: ReviewFixLoopDeps = {
      events: bus,
      git,
      runPostFixGate: async () => ({ outcome: 'pass', output: '' }),
      runReview: async (): Promise<ReviewStepResult> => ({
        invocationId: 'rev-1',
        agentOutcome: 'success',
        verdict: 'fail',
        offendingFindings: [{ severity: 'high', summary: 'bug' }],
      }),
      runFix: async (): Promise<FixStepResult> => ({
        invocationId: 'fix-1',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
        headBeforeFix: 'sha-pre',
      }),
      runRevalidation: async (): Promise<RevalidationResult> => ({
        validationRunId: 'val-1',
        passed: true,
      }),
      loops: {
        insert: () => {},
        update: () => {},
        getById: () => undefined,
        getByRunId: () => [],
      } as unknown as LoopRepositoryPort,
      now: () => new Date(),
      idFactory: () => 'id-1',
    };

    const loop = new ReviewFixLoop(deps);
    await loop.execute({
      runId: RunId('run-1'),
      phaseId: PhaseName('whole-pr-review'),
      repoId: 'owner/repo',
      cwd: '/wt',
      maxIterations: 2,
      reviewProfile: AgentProfileName('opencode-frontier'),
      fixProfile: AgentProfileName('pi-qwen-local'),
    });

    expect(addAllCalls).toEqual([]);
    expect(addCalls.length).toBeGreaterThan(0);
    expect(addCalls[0].files).toEqual(['packages/application/src/fix.ts']);
    expect(events.find((e) => e.type === 'fix.auto_commit.succeeded')).toBeDefined();
  });
});
