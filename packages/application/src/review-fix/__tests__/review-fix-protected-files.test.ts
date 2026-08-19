import { describe, it, expect, vi } from 'vitest';
import { RunId, PhaseName, AgentProfileName } from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import type { GitPort } from '../../ports/git-port.js';
import type { LoopRepositoryPort } from '../../ports/loop-repository-port.js';
import type { RevertProtectedFilesPort } from '../../ports/protected-file-reverter-port.js';
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

function makeFakeGit(opts: { headSha: string; changedFilesList?: string[] }): GitPort {
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
    commit: async () => 'sha-new',
    push: async () => undefined,
    remoteRef: async () => undefined,
    isAncestor: async () => true,
    logBetween: async () => [],
    cleanUntracked: async () => undefined,
    headCommitShaOf: async () => undefined,
    status: async () => '',
    resetWorktreeIfClean: async () => undefined,
    changedFiles: async () => opts.changedFilesList ?? [],
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
  };
}

function makeDeps(
  over: Partial<ReviewFixLoopDeps> & { revertProtectedFiles?: RevertProtectedFilesPort },
): ReviewFixLoopDeps {
  let n = 0;
  const { bus } = collectEvents();
  return {
    runPostFixGate: async (): Promise<PostFixGateResult> => ({ outcome: 'pass', output: '' }),
    runReview: async (): Promise<ReviewStepResult> => ({
      invocationId: `rev-${++n}`,
      agentOutcome: 'success',
      verdict: n === 1 ? 'fail' : 'pass',
      offendingFindings: n === 1 ? [{ severity: 'high', summary: 'bug' }] : undefined,
    }),
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
  it('reverts .gitignore modification and advances with amended SHA when revertProtectedFiles is provided', async () => {
    const { events, bus } = collectEvents();
    const git = makeFakeGit({
      headSha: 'sha-fix-1',
      changedFilesList: ['.gitignore', 'packages/application/src/fix.ts'],
    });
    const revertProtectedFiles = vi.fn<RevertProtectedFilesPort>(
      async ({ cwd: _cwd, baseline: _baseline, protectedFiles }) => ({
        revertedProtectedFiles: [...protectedFiles],
        removedNewlyIgnoredFiles: [],
        amendedHeadSha: 'sha-amended-1',
      }),
    );

    const deps = makeDeps({
      events: bus,
      git,
      revertProtectedFiles,
      runFix: async () => ({
        invocationId: 'fix-1',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
        headBeforeFix: 'sha-pre',
      }),
    });

    const loop = new ReviewFixLoop(deps);
    await loop.execute(baseInput());

    expect(revertProtectedFiles).toHaveBeenCalledTimes(1);
    expect(revertProtectedFiles).toHaveBeenCalledWith({
      cwd: '/wt',
      baseline: 'sha-pre',
      protectedFiles: ['.gitignore'],
    });

    const revertedEvent = events.find((e) => e.type === 'fix.protected_file_reverted');
    expect(revertedEvent).toBeDefined();
    expect(revertedEvent?.metadata.revertedProtectedFiles).toEqual(['.gitignore']);
    expect(revertedEvent?.metadata.amendedHeadSha).toBe('sha-amended-1');
  });

  it('reverts .ai-orchestrator.json and .github/ files and advances with amended SHA when revertProtectedFiles is provided', async () => {
    const { events, bus } = collectEvents();
    const git = makeFakeGit({
      headSha: 'sha-fix-1',
      changedFilesList: [
        '.ai-orchestrator.json',
        '.github/workflows/ci.yml',
        'packages/application/src/fix.ts',
      ],
    });
    const revertProtectedFiles = vi.fn<RevertProtectedFilesPort>(
      async ({ cwd: _cwd, baseline: _baseline, protectedFiles }) => ({
        revertedProtectedFiles: [...protectedFiles],
        removedNewlyIgnoredFiles: [],
        amendedHeadSha: 'sha-amended-2',
      }),
    );

    const deps = makeDeps({
      events: bus,
      git,
      revertProtectedFiles,
      runFix: async () => ({
        invocationId: 'fix-1',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
        headBeforeFix: 'sha-pre',
      }),
    });

    const loop = new ReviewFixLoop(deps);
    await loop.execute(baseInput());

    expect(revertProtectedFiles).toHaveBeenCalledTimes(1);
    expect(revertProtectedFiles).toHaveBeenCalledWith({
      cwd: '/wt',
      baseline: 'sha-pre',
      protectedFiles: ['.ai-orchestrator.json', '.github/workflows/ci.yml'],
    });

    const revertedEvent = events.find((e) => e.type === 'fix.protected_file_reverted');
    expect(revertedEvent).toBeDefined();
    expect(revertedEvent?.metadata.revertedProtectedFiles).toEqual([
      '.ai-orchestrator.json',
      '.github/workflows/ci.yml',
    ]);
    expect(revertedEvent?.metadata.amendedHeadSha).toBe('sha-amended-2');
  });

  it('fails task boundary and rolls back when protected files are modified and revertProtectedFiles is not provided', async () => {
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

  it('fails task boundary and rolls back when revertProtectedFiles throws an error', async () => {
    const { events, bus } = collectEvents();
    const rollbackCalls: string[] = [];
    const git = makeFakeGit({
      headSha: 'sha-fix-1',
      changedFilesList: ['.gitignore', 'packages/application/src/fix.ts'],
    });
    const revertProtectedFiles = vi.fn<RevertProtectedFilesPort>(async () => {
      throw new Error('git revert-protected-files error');
    });

    const deps = makeDeps({
      events: bus,
      git,
      revertProtectedFiles,
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
});
