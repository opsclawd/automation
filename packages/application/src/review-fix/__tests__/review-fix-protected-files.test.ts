import { describe, it, expect, vi } from 'vitest';
import { RunId, PhaseName, AgentProfileName } from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import type { GitPort } from '../../ports/git-port.js';
import type { LoopRepositoryPort } from '../../ports/loop-repository-port.js';
import type { RevertScopeFilesPort } from '../../ports/revert-scope-files-port.js';
import { ReviewFixLoop } from '../review-fix-loop.js';
import type {
  ReviewFixLoopDeps,
  ReviewStepResult,
  FixStepResult,
  RevalidationResult,
  PostFixGateResult,
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
      events.push({ type: e.type, level: e.level, message: e.message, metadata: e.metadata }),
    subscribe: () => () => {},
  };
  return { events, bus };
}

function makeFakeGit(opts: {
  headSha: string;
  changedFilesList?: string[];
  statusOutput?: string;
  commitSha?: string;
}): GitPort {
  let currentHead = opts.headSha;
  return {
    createWorktree: async () => undefined,
    removeWorktree: async () => undefined,
    currentBranch: async () => 'main',
    headCommitSha: async () => currentHead,
    resetHard: async (_cwd, sha) => {
      currentHead = sha;
    },
    diff: async () => '',
    diffStat: async () => '',
    add: async () => undefined,
    addAll: async () => undefined,
    commit: async () => opts.commitSha ?? 'sha-new',
    push: async () => undefined,
    remoteRef: async () => undefined,
    isAncestor: async () => true,
    logBetween: async () => [],
    cleanUntracked: async () => undefined,
    headCommitShaOf: async () => undefined,
    status: async () => opts.statusOutput ?? '',
    resetWorktreeIfClean: async () => undefined,
    changedFiles: async (_cwd, _base, target) => {
      if (target?.startsWith('sha-amended')) {
        return (opts.changedFilesList ?? []).filter(
          (f) => !f.startsWith('.') && !f.includes('.github'),
        );
      }
      return opts.changedFilesList ?? [];
    },
  };
}

function baseInput() {
  return {
    runId: RunId('run-1'),
    phaseId: PhaseName('whole-pr-review'),
    repoId: 'owner/repo',
    cwd: '/wt',
    maxIterations: 2,
    reviewProfile: AgentProfileName('opencode-frontier'),
    fixProfile: AgentProfileName('pi-qwen-local'),
    fixFallbackProfile: AgentProfileName('opencode-frontier'),
    manifest: {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1',
          expected_files: ['packages/application/src/fix.ts'],
        },
      ],
    },
  };
}

function makeDeps(
  over: Partial<ReviewFixLoopDeps> & { revertScopeFiles?: RevertScopeFilesPort },
): ReviewFixLoopDeps {
  let n = 0;
  let reviewCallCount = 0;
  const { bus } = collectEvents();
  return {
    runPostFixGate: async (): Promise<PostFixGateResult> => ({ outcome: 'pass', output: '' }),
    runReview: async (): Promise<ReviewStepResult> => {
      reviewCallCount += 1;
      return {
        invocationId: `rev-${++n}`,
        agentOutcome: 'success',
        verdict: reviewCallCount === 1 ? 'fail' : 'pass',
        offendingFindings:
          reviewCallCount === 1 ? [{ severity: 'high', summary: 'bug' }] : undefined,
      };
    },
    runFix: async (): Promise<FixStepResult> => ({
      invocationId: `fix-${++n}`,
      agentOutcome: 'success',
      verdict: 'done_with_fixes',
      headBeforeFix: 'sha-pre',
    }),
    runRevalidation: async (): Promise<RevalidationResult> => ({
      validationRunId: `val-${++n}`,
      passed: true,
    }),
    loops: {
      insert: () => {},
      update: () => {},
      getById: () => undefined,
      getByRunId: () => [],
    } as unknown as LoopRepositoryPort,
    events: bus,
    now: () => new Date(),
    idFactory: () => `id-${++n}`,
    ...over,
  } as ReviewFixLoopDeps;
}

describe('ReviewFixLoop protected file policy', () => {
  it('reverts .gitignore modification and advances with amended SHA when revertScopeFiles is provided', async () => {
    const { events, bus } = collectEvents();
    const git = makeFakeGit({
      headSha: 'sha-fix-1',
      changedFilesList: ['.gitignore', 'packages/application/src/fix.ts'],
    });
    const revertScopeFiles = vi.fn<RevertScopeFilesPort>(
      async ({ cwd: _cwd, baseline: _baseline, scopeFiles }) => ({
        revertedScopeFiles: [...scopeFiles],
        removedNewlyIgnoredFiles: [],
        amendedHeadSha: 'sha-amended-1',
      }),
    );

    const deps = makeDeps({
      events: bus,
      git,
      revertScopeFiles,
      runFix: async () => ({
        invocationId: 'fix-1',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
        headBeforeFix: 'sha-pre',
      }),
    });

    const loop = new ReviewFixLoop(deps);
    await loop.execute(baseInput());

    expect(revertScopeFiles).toHaveBeenCalledTimes(1);
    expect(revertScopeFiles).toHaveBeenCalledWith({
      cwd: '/wt',
      baseline: 'sha-pre',
      expectedHeadSha: 'sha-fix-1',
      rewriteSafety: 'unpublished',
      scopeFiles: ['.gitignore'],
    });

    const revertedEvent = events.find((e) => e.type === 'fix.protected_file_reverted');
    expect(revertedEvent).toBeDefined();
    expect(revertedEvent?.metadata.revertedScopeFiles).toEqual(['.gitignore']);
    expect(revertedEvent?.metadata.amendedHeadSha).toBe('sha-amended-1');
  });

  it('reverts .ai-orchestrator.json and .github/ files and advances with amended SHA when revertScopeFiles is provided', async () => {
    const { events, bus } = collectEvents();
    const git = makeFakeGit({
      headSha: 'sha-fix-1',
      changedFilesList: [
        '.ai-orchestrator.json',
        '.github/workflows/ci.yml',
        'packages/application/src/fix.ts',
      ],
    });
    const revertScopeFiles = vi.fn<RevertScopeFilesPort>(
      async ({ cwd: _cwd, baseline: _baseline, scopeFiles }) => ({
        revertedScopeFiles: [...scopeFiles],
        removedNewlyIgnoredFiles: [],
        amendedHeadSha: 'sha-amended-2',
      }),
    );

    const deps = makeDeps({
      events: bus,
      git,
      revertScopeFiles,
      runFix: async () => ({
        invocationId: 'fix-1',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
        headBeforeFix: 'sha-pre',
      }),
    });

    const loop = new ReviewFixLoop(deps);
    await loop.execute(baseInput());

    expect(revertScopeFiles).toHaveBeenCalledTimes(1);
    expect(revertScopeFiles).toHaveBeenCalledWith({
      cwd: '/wt',
      baseline: 'sha-pre',
      expectedHeadSha: 'sha-fix-1',
      rewriteSafety: 'unpublished',
      scopeFiles: ['.ai-orchestrator.json', '.github/workflows/ci.yml'],
    });

    const revertedEvent = events.find((e) => e.type === 'fix.protected_file_reverted');
    expect(revertedEvent).toBeDefined();
    expect(revertedEvent?.metadata.revertedScopeFiles).toEqual([
      '.ai-orchestrator.json',
      '.github/workflows/ci.yml',
    ]);
    expect(revertedEvent?.metadata.amendedHeadSha).toBe('sha-amended-2');
  });

  it('fails task boundary and rolls back when protected files are modified and revertScopeFiles is not provided', async () => {
    const { events, bus } = collectEvents();
    const rollbackCalls: string[] = [];
    const git = makeFakeGit({
      headSha: 'sha-fix-1',
      changedFilesList: ['.gitignore', 'packages/application/src/fix.ts'],
    });

    const deps = makeDeps({
      events: bus,
      git,
      rollbackFix: async (_ctx, targetSha) => {
        rollbackCalls.push(targetSha);
        return true;
      },
      runFix: async () => ({
        invocationId: 'fix-1',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
        headBeforeFix: 'sha-pre',
      }),
    });

    const loop = new ReviewFixLoop(deps);
    await loop.execute(baseInput());

    expect(rollbackCalls).toContain('sha-pre');
    expect(events.find((e) => e.type === 'task_boundary.violated')).toBeDefined();
  });

  it('fails task boundary and rolls back when revertScopeFiles throws an error', async () => {
    const { events, bus } = collectEvents();
    const rollbackCalls: string[] = [];
    const git = makeFakeGit({
      headSha: 'sha-fix-1',
      changedFilesList: ['.gitignore', 'packages/application/src/fix.ts'],
    });
    const revertScopeFiles = vi.fn<RevertScopeFilesPort>(async () => {
      throw new Error('git revert-scope-files error');
    });

    const deps = makeDeps({
      events: bus,
      git,
      revertScopeFiles,
      rollbackFix: async (_ctx, targetSha) => {
        rollbackCalls.push(targetSha);
        return true;
      },
      runFix: async () => ({
        invocationId: 'fix-1',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
        headBeforeFix: 'sha-pre',
      }),
    });

    const loop = new ReviewFixLoop(deps);
    await loop.execute(baseInput());

    expect(rollbackCalls).toContain('sha-pre');
    expect(events.find((e) => e.type === 'task_boundary.violated')).toBeDefined();
  });

  it('reverts protected files during auto-commit fallback when fixer leaves uncommitted changes and advances with amended SHA', async () => {
    const { events, bus } = collectEvents();
    const git = makeFakeGit({
      headSha: 'sha-pre',
      statusOutput: ' M .gitignore\n M packages/application/src/fix.ts',
      commitSha: 'sha-auto-1',
      changedFilesList: ['.gitignore', 'packages/application/src/fix.ts'],
    });
    const revertScopeFiles = vi.fn<RevertScopeFilesPort>(
      async ({ cwd: _cwd, baseline: _baseline, scopeFiles }) => ({
        revertedScopeFiles: [...scopeFiles],
        removedNewlyIgnoredFiles: [],
        amendedHeadSha: 'sha-amended-auto-1',
      }),
    );

    const deps = makeDeps({
      events: bus,
      git,
      revertScopeFiles,
      runFix: async () => ({
        invocationId: 'fix-1',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
        headBeforeFix: 'sha-pre',
      }),
    });

    const loop = new ReviewFixLoop(deps);
    const result = await loop.execute(baseInput());

    expect(revertScopeFiles).toHaveBeenCalledTimes(1);
    expect(revertScopeFiles).toHaveBeenCalledWith({
      cwd: '/wt',
      baseline: 'sha-pre',
      expectedHeadSha: 'sha-auto-1',
      rewriteSafety: 'unpublished',
      scopeFiles: ['.gitignore'],
    });

    const revertedEvent = events.find((e) => e.type === 'fix.protected_file_reverted');
    expect(revertedEvent).toBeDefined();
    expect(revertedEvent?.metadata.revertedScopeFiles).toEqual(['.gitignore']);
    expect(revertedEvent?.metadata.amendedHeadSha).toBe('sha-amended-auto-1');

    const autoCommitEvent = events.find((e) => e.type === 'fix.auto_commit.succeeded');
    expect(autoCommitEvent).toBeDefined();
    expect(autoCommitEvent?.metadata.sha).toBe('sha-amended-auto-1');

    expect(result.phaseOutcome).toBe('passed');
  });

  it('reverts protected files during deterministic gate auto-commit fallback and succeeds', async () => {
    const { events, bus } = collectEvents();
    let gateCalls = 0;
    let fixCalls = 0;
    let gitHead = 'sha-pre';
    const fakeGit: GitPort = {
      createWorktree: async () => undefined,
      removeWorktree: async () => undefined,
      currentBranch: async () => 'main',
      headCommitSha: async () => gitHead,
      resetHard: async (_cwd, sha) => {
        gitHead = sha;
      },
      diff: async () => '',
      diffStat: async () => '',
      add: async () => undefined,
      addAll: async () => undefined,
      commit: async () => 'sha-auto-gate-1',
      push: async () => undefined,
      remoteRef: async () => undefined,
      isAncestor: async () => true,
      logBetween: async () => [],
      cleanUntracked: async () => undefined,
      headCommitShaOf: async () => undefined,
      status: async () =>
        fixCalls >= 2 ? ' M .gitignore\n M packages/application/src/fix.ts' : '',
      resetWorktreeIfClean: async () => undefined,
      changedFiles: async (_cwd, _base, target) => {
        if (target?.startsWith('sha-amended')) {
          return ['packages/application/src/fix.ts'];
        }
        if (target === 'sha-auto-gate-1') {
          return ['.gitignore', 'packages/application/src/fix.ts'];
        }
        return ['packages/application/src/fix.ts'];
      },
    };
    const revertScopeFiles = vi.fn<RevertScopeFilesPort>(
      async ({ cwd: _cwd, baseline: _baseline, scopeFiles }) => ({
        revertedScopeFiles: [...scopeFiles],
        removedNewlyIgnoredFiles: [],
        amendedHeadSha: 'sha-amended-gate-1',
      }),
    );

    const deps = makeDeps({
      events: bus,
      git: fakeGit,
      revertScopeFiles,
      runPostFixGate: async (): Promise<PostFixGateResult> => {
        gateCalls += 1;
        // Fail on iteration 2 (post-fix gate) first time, then pass next
        if (gateCalls === 1) {
          return { outcome: 'fail', output: 'gate error' };
        }
        return { outcome: 'pass', output: '' };
      },
      runFix: async () => {
        fixCalls += 1;
        if (fixCalls === 1) {
          gitHead = 'sha-fix-1';
          return {
            invocationId: 'fix-1',
            agentOutcome: 'success',
            verdict: 'done_with_fixes',
            headBeforeFix: 'sha-pre',
          };
        }
        return {
          invocationId: 'fix-2',
          agentOutcome: 'success',
          verdict: 'done_with_fixes',
          headBeforeFix: 'sha-fix-1',
        };
      },
    });

    const loop = new ReviewFixLoop(deps);
    const result = await loop.execute(baseInput());

    expect(revertScopeFiles).toHaveBeenCalledTimes(1);
    expect(revertScopeFiles).toHaveBeenCalledWith({
      cwd: '/wt',
      baseline: 'sha-fix-1',
      expectedHeadSha: 'sha-auto-gate-1',
      rewriteSafety: 'unpublished',
      scopeFiles: ['.gitignore'],
    });

    const revertedEvent = events.find((e) => e.type === 'fix.protected_file_reverted');
    expect(revertedEvent).toBeDefined();
    expect(revertedEvent?.metadata.revertedScopeFiles).toEqual(['.gitignore']);
    expect(revertedEvent?.metadata.amendedHeadSha).toBe('sha-amended-gate-1');
    expect(result.phaseOutcome).toBe('passed');
  });
});
