import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RunId, PhaseName, AgentProfileName } from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { ReviewFixLoop } from '../review-fix-loop.js';
import { FakeGitPort } from '../../test-doubles/fake-git-port.js';
import { FakeLoopRepository } from '../../test-doubles/fake-loop-repository.js';
import { FakeArtifactStore } from '../../test-doubles/fake-artifact-store.js';
import type { ReviewFixLoopDeps, ReviewFixLoopInput } from '../types.js';

describe('ReviewFixLoop task boundary enforcement (regression)', () => {
  let events: OrchestratorEvent[];
  let git: FakeGitPort;
  let loops: FakeLoopRepository;
  let artifacts: FakeArtifactStore;
  let baseDeps: ReviewFixLoopDeps;
  let baseInput: ReviewFixLoopInput;

  beforeEach(() => {
    events = [];
    git = new FakeGitPort();
    loops = new FakeLoopRepository();
    artifacts = new FakeArtifactStore();

    baseDeps = {
      runPostFixGate: vi.fn().mockResolvedValue({ outcome: 'pass', output: '' }),
      runReview: vi.fn(),
      runFix: vi.fn(),
      runRevalidation: vi.fn().mockResolvedValue({
        validationRunId: 'val-1',
        passed: true,
      }),
      loops,
      events: {
        publish: (_u: string, e: OrchestratorEvent) => {
          events.push(e);
        },
        subscribe: () => () => {},
      },
      now: () => new Date('2026-06-16T00:00:00Z'),
      idFactory: () => 'loop-1',
      rollbackFix: vi.fn().mockResolvedValue(true),
      git,
      artifactStore: artifacts,
      options: { endOnReview: false },
    };

    baseInput = {
      runId: RunId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
      phaseId: PhaseName('review-fix'),
      repoId: 'acme/widgets',
      cwd: '/tmp/wt',
      maxIterations: 3,
      reviewProfile: AgentProfileName('pi-qwen-local'),
      fixProfile: AgentProfileName('opencode-frontier'),
      manifest: {
        version: 2,
        task_count: 1,
        tasks: [
          {
            n: 1,
            title: 'Task 1',
            expected_files: ['src/feature/declared.ts'],
          },
        ],
      },
    };

    git.headByCwd.set('/tmp/wt', 'head-0');
  });

  it('detects undeclared files in review-fix commit, emits task_boundary.violated, rolls back commit, surfaces synthetic finding, and marks iteration unresolved', async () => {
    vi.mocked(baseDeps.runReview).mockResolvedValueOnce({
      invocationId: 'rev-1',
      agentOutcome: 'success',
      verdict: 'fail',
      offendingFindings: [
        { severity: 'P1', summary: 'bug in logic', files: ['src/feature/declared.ts'] },
      ],
    });

    git.headByCwd.set('/tmp/wt', 'head-1');
    git.changedFilesResults.set('head-0|head-1', ['src/undeclared.ts']);

    vi.mocked(baseDeps.runFix).mockResolvedValueOnce({
      invocationId: 'fix-1',
      agentOutcome: 'success',
      verdict: 'done_with_fixes',
      headBeforeFix: 'head-0',
      summary: 'addressed finding',
    });

    const loop = new ReviewFixLoop(baseDeps);
    const result = await loop.execute({
      ...baseInput,
      maxIterations: 1,
    });

    const boundaryEvents = events.filter((e) => e.type === 'task_boundary.violated');
    expect(boundaryEvents).toHaveLength(1);
    expect(boundaryEvents[0]?.phase).toBe('review-fix');
    expect(boundaryEvents[0]?.message).toContain(
      'review-fix modified undeclared files: src/undeclared.ts',
    );
    expect((boundaryEvents[0]?.metadata as { files?: string[] } | undefined)?.files).toEqual([
      'src/undeclared.ts',
    ]);

    expect(baseDeps.rollbackFix).toHaveBeenCalledWith(
      expect.objectContaining({ iterationIndex: 1 }),
      'head-0',
    );
    expect(result.phaseOutcome).toBe('failed');
    expect(result.loop.iterations[0]?.outcome).toBe('unresolved');
  });

  it('recovers in subsequent iteration after boundary violation', async () => {
    vi.mocked(baseDeps.runReview)
      .mockResolvedValueOnce({
        invocationId: 'rev-1',
        agentOutcome: 'success',
        verdict: 'fail',
        offendingFindings: [
          { severity: 'P1', summary: 'bug in logic', files: ['src/feature/declared.ts'] },
        ],
      })
      .mockResolvedValueOnce({
        invocationId: 'rev-2',
        agentOutcome: 'success',
        verdict: 'fail',
        offendingFindings: [
          { severity: 'P1', summary: 'bug in logic', files: ['src/feature/declared.ts'] },
        ],
      })
      .mockResolvedValueOnce({
        invocationId: 'rev-3',
        agentOutcome: 'success',
        verdict: 'pass',
        offendingFindings: [],
      });

    // Iteration 1 fixer touches undeclared file -> violation
    git.changedFilesResults.set('head-0|head-1', ['src/undeclared.ts']);

    // Iteration 2 fixer touches declared file -> success
    git.changedFilesResults.set('head-0|head-2', ['src/feature/declared.ts']);

    vi.mocked(baseDeps.runFix)
      .mockImplementationOnce(async () => {
        git.headByCwd.set('/tmp/wt', 'head-1');
        return {
          invocationId: 'fix-1',
          agentOutcome: 'success',
          verdict: 'done_with_fixes',
          headBeforeFix: 'head-0',
          summary: 'attempt 1 with undeclared file',
        };
      })
      .mockImplementationOnce(async () => {
        git.headByCwd.set('/tmp/wt', 'head-2');
        return {
          invocationId: 'fix-2',
          agentOutcome: 'success',
          verdict: 'done_with_fixes',
          headBeforeFix: 'head-0',
          summary: 'attempt 2 with declared file',
        };
      });

    const loop = new ReviewFixLoop(baseDeps);
    const result = await loop.execute({
      ...baseInput,
      maxIterations: 3,
    });

    expect(result.phaseOutcome).toBe('passed');
    expect(result.loop.iterations[0]?.outcome).toBe('unresolved');
    expect(result.loop.iterations[1]?.outcome).toBe('fixed');
    expect(result.loop.iterations[2]?.outcome).toBe('resolved');
    expect(events.filter((e) => e.type === 'task_boundary.violated')).toHaveLength(1);
  });

  it('reports whole-pr-fix-review phase name in task_boundary.violated when phaseId is whole-pr-fix-review', async () => {
    vi.mocked(baseDeps.runReview).mockResolvedValueOnce({
      invocationId: 'rev-1',
      agentOutcome: 'success',
      verdict: 'fail',
      offendingFindings: [
        { severity: 'P1', summary: 'bug in logic', files: ['src/feature/declared.ts'] },
      ],
    });

    git.headByCwd.set('/tmp/wt', 'head-1');
    git.changedFilesResults.set('head-0|head-1', ['src/undeclared.ts']);

    vi.mocked(baseDeps.runFix).mockResolvedValueOnce({
      invocationId: 'fix-1',
      agentOutcome: 'success',
      verdict: 'done_with_fixes',
      headBeforeFix: 'head-0',
      summary: 'addressed finding',
    });

    const loop = new ReviewFixLoop(baseDeps);
    const result = await loop.execute({
      ...baseInput,
      phaseId: PhaseName('whole-pr-fix-review'),
      maxIterations: 1,
    });

    const boundaryEvents = events.filter((e) => e.type === 'task_boundary.violated');
    expect(boundaryEvents).toHaveLength(1);
    expect(boundaryEvents[0]?.phase).toBe('whole-pr-fix-review');
    expect(boundaryEvents[0]?.message).toContain(
      'whole-pr-fix-review modified undeclared files: src/undeclared.ts',
    );
    expect(baseDeps.rollbackFix).toHaveBeenCalledWith(
      expect.objectContaining({ iterationIndex: 1 }),
      'head-0',
    );
    expect(result.phaseOutcome).toBe('failed');
    expect(result.loop.iterations[0]?.outcome).toBe('unresolved');
  });

  it('does not emit boundary violation when review-fix commit touches only declared files', async () => {
    vi.mocked(baseDeps.runReview)
      .mockResolvedValueOnce({
        invocationId: 'rev-1',
        agentOutcome: 'success',
        verdict: 'fail',
        offendingFindings: [
          { severity: 'P1', summary: 'bug in logic', files: ['src/feature/declared.ts'] },
        ],
      })
      .mockResolvedValueOnce({
        invocationId: 'rev-2',
        agentOutcome: 'success',
        verdict: 'pass',
        offendingFindings: [],
      });

    git.headByCwd.set('/tmp/wt', 'head-1');
    git.changedFilesResults.set('head-0|head-1', ['src/feature/declared.ts']);

    vi.mocked(baseDeps.runFix).mockResolvedValueOnce({
      invocationId: 'fix-1',
      agentOutcome: 'success',
      verdict: 'done_with_fixes',
      headBeforeFix: 'head-0',
      summary: 'addressed finding',
    });

    const loop = new ReviewFixLoop(baseDeps);
    const result = await loop.execute(baseInput);

    expect(result.phaseOutcome).toBe('passed');
    const boundaryEvents = events.filter((e) => e.type === 'task_boundary.violated');
    expect(boundaryEvents).toHaveLength(0);
    expect(baseDeps.rollbackFix).not.toHaveBeenCalled();
  });

  it('carries boundary violation failure detail into next runFix call through deterministicDiagnostic', async () => {
    vi.mocked(baseDeps.runReview)
      .mockResolvedValueOnce({
        invocationId: 'rev-1',
        agentOutcome: 'success',
        verdict: 'fail',
        offendingFindings: [
          { severity: 'P1', summary: 'bug in logic', files: ['src/feature/declared.ts'] },
        ],
      })
      .mockResolvedValueOnce({
        invocationId: 'rev-2',
        agentOutcome: 'success',
        verdict: 'fail',
        offendingFindings: [
          { severity: 'P1', summary: 'bug in logic', files: ['src/feature/declared.ts'] },
        ],
      });

    git.headByCwd.set('/tmp/wt', 'head-1');
    git.changedFilesResults.set('head-0|head-1', ['src/undeclared.ts']);

    const fixCalls: import('../types.js').FixStepOptions[] = [];
    vi.mocked(baseDeps.runFix)
      .mockImplementationOnce(async (_ctx, opts) => {
        fixCalls.push(opts);
        return {
          invocationId: 'fix-1',
          agentOutcome: 'success',
          verdict: 'done_with_fixes',
          headBeforeFix: 'head-0',
          summary: 'attempt 1 with undeclared file',
        };
      })
      .mockImplementationOnce(async (_ctx, opts) => {
        fixCalls.push(opts);
        git.headByCwd.set('/tmp/wt', 'head-2');
        git.changedFilesResults.set('head-0|head-2', ['src/feature/declared.ts']);
        return {
          invocationId: 'fix-2',
          agentOutcome: 'success',
          verdict: 'done_with_fixes',
          headBeforeFix: 'head-0',
          summary: 'attempt 2 with declared file',
        };
      });

    const loop = new ReviewFixLoop(baseDeps);
    await loop.execute({ ...baseInput, maxIterations: 2 });

    expect(fixCalls).toHaveLength(2);
    expect(fixCalls[0]?.deterministicDiagnostic).toBeUndefined();
    expect(fixCalls[1]?.deterministicDiagnostic).toContain(
      'review-fix modified undeclared files: src/undeclared.ts',
    );
  });

  it('enforces task boundaries in auto-commit fallback path when undeclared files are committed', async () => {
    vi.mocked(baseDeps.runReview).mockResolvedValueOnce({
      invocationId: 'rev-1',
      agentOutcome: 'success',
      verdict: 'fail',
      offendingFindings: [
        { severity: 'P1', summary: 'bug in logic', files: ['src/feature/declared.ts'] },
      ],
    });

    git.headByCwd.set('/tmp/wt', 'head-0');
    git.statusByCwd.set('/tmp/wt', 'M src/undeclared.ts');
    git.changedFilesResults.set('head-0|fake-sha-1', ['src/undeclared.ts']);

    vi.mocked(baseDeps.runFix).mockResolvedValueOnce({
      invocationId: 'fix-1',
      agentOutcome: 'success',
      verdict: 'done_with_fixes',
      headBeforeFix: 'head-0',
      summary: 'left dirty undeclared file',
    });

    const loop = new ReviewFixLoop(baseDeps);
    const result = await loop.execute({ ...baseInput, maxIterations: 1 });

    const boundaryEvents = events.filter((e) => e.type === 'task_boundary.violated');
    expect(boundaryEvents).toHaveLength(1);
    expect(boundaryEvents[0]?.message).toContain(
      'review-fix modified undeclared files: src/undeclared.ts',
    );
    expect(baseDeps.rollbackFix).toHaveBeenCalledWith(
      expect.objectContaining({ iterationIndex: 1 }),
      'head-0',
    );
    expect(result.phaseOutcome).toBe('failed');
    expect(result.loop.iterations[0]?.outcome).toBe('unresolved');
  });

  it('enforces task boundaries in deterministic gate fix path when undeclared files are committed', async () => {
    vi.mocked(baseDeps.runPostFixGate)
      .mockResolvedValueOnce({ outcome: 'fail', output: 'typecheck failed' })
      .mockResolvedValueOnce({ outcome: 'pass', output: '' });

    vi.mocked(baseDeps.runReview).mockResolvedValueOnce({
      invocationId: 'rev-1',
      agentOutcome: 'success',
      verdict: 'fail',
      offendingFindings: [
        { severity: 'P1', summary: 'initial review finding', files: ['src/feature/declared.ts'] },
      ],
    });

    git.headByCwd.set('/tmp/wt', 'head-1');
    git.changedFilesResults.set('head-0|head-1', ['src/feature/declared.ts']);

    // Fix 1 commits declared file, advances head to head-1
    vi.mocked(baseDeps.runFix).mockResolvedValueOnce({
      invocationId: 'fix-1',
      agentOutcome: 'success',
      verdict: 'done_with_fixes',
      headBeforeFix: 'head-0',
      summary: 'fixed review finding',
    });

    const loop = new ReviewFixLoop(baseDeps);
    // Execute iteration 1 (produces fix-1 commit)
    // Then iteration 2 starts with failing post-fix gate
    git.changedFilesResults.set('head-1|head-2', ['src/undeclared.ts']);
    vi.mocked(baseDeps.runFix).mockImplementationOnce(async () => {
      git.headByCwd.set('/tmp/wt', 'head-2');
      return {
        invocationId: 'fix-2',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
        headBeforeFix: 'head-1',
        summary: 'fixed gate by touching undeclared file',
      };
    });

    const result = await loop.execute({ ...baseInput, maxIterations: 2 });

    const boundaryEvents = events.filter((e) => e.type === 'task_boundary.violated');
    expect(boundaryEvents).toHaveLength(1);
    expect(boundaryEvents[0]?.message).toContain(
      'review-fix modified undeclared files: src/undeclared.ts',
    );
    expect(baseDeps.rollbackFix).toHaveBeenCalledWith(
      expect.objectContaining({ iterationIndex: 2 }),
      'head-1',
    );
    expect(result.phaseOutcome).toBe('failed');
  });

  it('recovers in deterministic gate fix path on next iteration after boundary violation, staying in deterministic mode without running review', async () => {
    vi.mocked(baseDeps.runPostFixGate)
      .mockResolvedValueOnce({ outcome: 'fail', output: 'typecheck failed' })
      .mockResolvedValueOnce({ outcome: 'pass', output: '' });

    vi.mocked(baseDeps.runReview)
      .mockResolvedValueOnce({
        invocationId: 'rev-1',
        agentOutcome: 'success',
        verdict: 'fail',
        offendingFindings: [
          { severity: 'P1', summary: 'initial review finding', files: ['src/feature/declared.ts'] },
        ],
      })
      .mockResolvedValueOnce({
        invocationId: 'rev-2',
        agentOutcome: 'success',
        verdict: 'pass',
        offendingFindings: [],
      });

    git.headByCwd.set('/tmp/wt', 'head-1');
    git.changedFilesResults.set('head-0|head-1', ['src/feature/declared.ts']);

    const fixCalls: import('../types.js').FixStepOptions[] = [];
    vi.mocked(baseDeps.runFix)
      .mockImplementationOnce(async (_ctx, opts) => {
        fixCalls.push(opts);
        return {
          invocationId: 'fix-1',
          agentOutcome: 'success',
          verdict: 'done_with_fixes',
          headBeforeFix: 'head-0',
          summary: 'fixed review finding',
        };
      })
      .mockImplementationOnce(async (_ctx, opts) => {
        fixCalls.push(opts);
        git.headByCwd.set('/tmp/wt', 'head-2');
        git.changedFilesResults.set('head-1|head-2', ['src/undeclared.ts']);
        return {
          invocationId: 'fix-2',
          agentOutcome: 'success',
          verdict: 'done_with_fixes',
          headBeforeFix: 'head-1',
          summary: 'fixed gate by touching undeclared file',
        };
      })
      .mockImplementationOnce(async (_ctx, opts) => {
        fixCalls.push(opts);
        git.headByCwd.set('/tmp/wt', 'head-3');
        git.changedFilesResults.set('head-1|head-3', ['src/feature/declared.ts']);
        return {
          invocationId: 'fix-3',
          agentOutcome: 'success',
          verdict: 'done_with_fixes',
          headBeforeFix: 'head-1',
          summary: 'fixed gate by touching declared file',
        };
      });

    const loop = new ReviewFixLoop(baseDeps);
    const result = await loop.execute({ ...baseInput, maxIterations: 4 });

    expect(result.phaseOutcome).toBe('passed');
    expect(result.loop.iterations).toHaveLength(4);
    expect(result.loop.iterations[0]?.outcome).toBe('fixed');
    expect(result.loop.iterations[1]?.outcome).toBe('unresolved');
    expect(result.loop.iterations[2]?.outcome).toBe('fixed');
    expect(result.loop.iterations[3]?.outcome).toBe('resolved');

    expect(baseDeps.runReview).toHaveBeenCalledTimes(2);
    expect(fixCalls).toHaveLength(3);
    expect(fixCalls[1]?.attemptKind).toBe('deterministic');
    expect(fixCalls[1]?.deterministicDiagnostic).toBe('typecheck failed');
    expect(fixCalls[1]?.allowedFiles).toEqual(['src/feature/declared.ts']);
    expect(fixCalls[2]?.attemptKind).toBe('deterministic');
    expect(fixCalls[2]?.deterministicDiagnostic).toContain('typecheck failed');
    expect(fixCalls[2]?.deterministicDiagnostic).toContain(
      'review-fix modified undeclared files: src/undeclared.ts',
    );
    expect(fixCalls[2]?.allowedFiles).toEqual(['src/feature/declared.ts']);
  });

  it('treats malformed manifest in artifactStore as synthetic check failure', async () => {
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'task-manifest.json',
      contents: '{ broken json ::: ',
    });

    const inputWithoutManifest = {
      ...baseInput,
      maxIterations: 1,
      manifest: undefined,
    };

    vi.mocked(baseDeps.runReview).mockResolvedValueOnce({
      invocationId: 'rev-1',
      agentOutcome: 'success',
      verdict: 'fail',
      offendingFindings: [
        { severity: 'P1', summary: 'bug in logic', files: ['src/feature/declared.ts'] },
      ],
    });

    git.headByCwd.set('/tmp/wt', 'head-1');
    git.changedFilesResults.set('head-0|head-1', ['src/feature/declared.ts']);

    vi.mocked(baseDeps.runFix).mockResolvedValueOnce({
      invocationId: 'fix-1',
      agentOutcome: 'success',
      verdict: 'done_with_fixes',
      headBeforeFix: 'head-0',
      summary: 'attempted fix',
    });

    const loop = new ReviewFixLoop(baseDeps);
    const result = await loop.execute(inputWithoutManifest);

    expect(result.phaseOutcome).toBe('failed');
    expect(baseDeps.rollbackFix).toHaveBeenCalled();

    const checkFailedEvents = events.filter((e) => e.type === 'task_boundary.check_failed');
    expect(checkFailedEvents).toHaveLength(1);
    expect(checkFailedEvents[0]?.metadata).toMatchObject({
      reason: 'malformed_manifest',
    });
  });

  it('treats missing manifest as synthetic check failure, emits check_failed, rolls back, and marks iteration unresolved', async () => {
    const inputWithoutManifest = {
      ...baseInput,
      maxIterations: 1,
      manifest: undefined,
    };

    vi.mocked(baseDeps.runReview).mockResolvedValueOnce({
      invocationId: 'rev-1',
      agentOutcome: 'success',
      verdict: 'fail',
      offendingFindings: [
        { severity: 'P1', summary: 'bug in logic', files: ['src/feature/declared.ts'] },
      ],
    });

    git.headByCwd.set('/tmp/wt', 'head-1');
    git.changedFilesResults.set('head-0|head-1', ['src/feature/declared.ts']);

    vi.mocked(baseDeps.runFix).mockResolvedValueOnce({
      invocationId: 'fix-1',
      agentOutcome: 'success',
      verdict: 'done_with_fixes',
      headBeforeFix: 'head-0',
      summary: 'attempted fix',
    });

    const loop = new ReviewFixLoop(baseDeps);
    const result = await loop.execute(inputWithoutManifest);

    expect(result.phaseOutcome).toBe('failed');
    expect(baseDeps.rollbackFix).toHaveBeenCalledWith(
      expect.objectContaining({ iterationIndex: 1 }),
      'head-0',
    );

    const checkFailedEvents = events.filter((e) => e.type === 'task_boundary.check_failed');
    expect(checkFailedEvents).toHaveLength(1);
    expect(checkFailedEvents[0]?.metadata).toMatchObject({
      reason: 'missing_manifest',
      error: 'task-manifest.json not found',
    });
  });

  it('treats git errors during boundary check as synthetic failure, rolls back, and marks iteration unresolved', async () => {
    git.changedFiles = vi.fn().mockRejectedValue(new Error('git error: corrupt pack file'));

    vi.mocked(baseDeps.runReview).mockResolvedValueOnce({
      invocationId: 'rev-1',
      agentOutcome: 'success',
      verdict: 'fail',
      offendingFindings: [
        { severity: 'P1', summary: 'bug in logic', files: ['src/feature/declared.ts'] },
      ],
    });

    git.headByCwd.set('/tmp/wt', 'head-1');

    vi.mocked(baseDeps.runFix).mockResolvedValueOnce({
      invocationId: 'fix-1',
      agentOutcome: 'success',
      verdict: 'done_with_fixes',
      headBeforeFix: 'head-0',
      summary: 'attempted fix',
    });

    const loop = new ReviewFixLoop(baseDeps);
    const result = await loop.execute({ ...baseInput, maxIterations: 1 });

    expect(result.phaseOutcome).toBe('failed');
    expect(baseDeps.rollbackFix).toHaveBeenCalledWith(
      expect.objectContaining({ iterationIndex: 1 }),
      'head-0',
    );
    const errorEvents = events.filter((e) => e.type === 'task_boundary.check_failed');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]?.message).toContain('git error: corrupt pack file');
  });

  it('loads manifest from artifactStore when input.manifest is undefined', async () => {
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'task-manifest.json',
      contents: JSON.stringify({
        version: 2,
        task_count: 1,
        tasks: [{ n: 1, title: 'Task 1', expected_files: ['src/feature/declared.ts'] }],
      }),
    });

    const inputWithoutManifest = {
      ...baseInput,
      maxIterations: 1,
      manifest: undefined,
    };

    vi.mocked(baseDeps.runReview).mockResolvedValueOnce({
      invocationId: 'rev-1',
      agentOutcome: 'success',
      verdict: 'fail',
      offendingFindings: [
        { severity: 'P1', summary: 'bug in logic', files: ['src/feature/declared.ts'] },
      ],
    });

    git.headByCwd.set('/tmp/wt', 'head-1');
    git.changedFilesResults.set('head-0|head-1', ['src/undeclared.ts']);

    vi.mocked(baseDeps.runFix).mockResolvedValueOnce({
      invocationId: 'fix-1',
      agentOutcome: 'success',
      verdict: 'done_with_fixes',
      headBeforeFix: 'head-0',
      summary: 'attempted fix with undeclared file',
    });

    const loop = new ReviewFixLoop(baseDeps);
    const result = await loop.execute(inputWithoutManifest);

    const boundaryEvents = events.filter((e) => e.type === 'task_boundary.violated');
    expect(boundaryEvents).toHaveLength(1);
    expect(boundaryEvents[0]?.message).toContain(
      'review-fix modified undeclared files: src/undeclared.ts',
    );
    expect(baseDeps.rollbackFix).toHaveBeenCalledWith(
      expect.objectContaining({ iterationIndex: 1 }),
      'head-0',
    );
    expect(result.phaseOutcome).toBe('failed');
  });

  it('loads manifest from readWorktreeFile when input.manifest and artifactStore are undefined', async () => {
    const inputWithoutManifest = {
      ...baseInput,
      maxIterations: 1,
      manifest: undefined,
    };

    const depsWithWorktreeFile: ReviewFixLoopDeps = {
      ...baseDeps,
      artifactStore: undefined,
      readWorktreeFile: vi.fn().mockResolvedValue(
        JSON.stringify({
          version: 2,
          task_count: 1,
          tasks: [{ n: 1, title: 'Task 1', expected_files: ['src/feature/declared.ts'] }],
        }),
      ),
    };

    vi.mocked(depsWithWorktreeFile.runReview).mockResolvedValueOnce({
      invocationId: 'rev-1',
      agentOutcome: 'success',
      verdict: 'fail',
      offendingFindings: [
        { severity: 'P1', summary: 'bug in logic', files: ['src/feature/declared.ts'] },
      ],
    });

    git.headByCwd.set('/tmp/wt', 'head-1');
    git.changedFilesResults.set('head-0|head-1', ['src/undeclared.ts']);

    vi.mocked(depsWithWorktreeFile.runFix).mockResolvedValueOnce({
      invocationId: 'fix-1',
      agentOutcome: 'success',
      verdict: 'done_with_fixes',
      headBeforeFix: 'head-0',
      summary: 'attempted fix with undeclared file',
    });

    const loop = new ReviewFixLoop(depsWithWorktreeFile);
    const result = await loop.execute(inputWithoutManifest);

    const boundaryEvents = events.filter((e) => e.type === 'task_boundary.violated');
    expect(boundaryEvents).toHaveLength(1);
    expect(depsWithWorktreeFile.readWorktreeFile).toHaveBeenCalledWith(
      '/tmp/wt',
      'task-manifest.json',
    );
    expect(depsWithWorktreeFile.rollbackFix).toHaveBeenCalledWith(
      expect.objectContaining({ iterationIndex: 1 }),
      'head-0',
    );
    expect(result.phaseOutcome).toBe('failed');
  });

  it('resets consecutiveFixFailures on boundary violation to prevent premature fallback escalation', async () => {
    const fixCalls: import('../types.js').FixStepOptions[] = [];
    vi.mocked(baseDeps.runReview)
      .mockResolvedValueOnce({
        invocationId: 'rev-1',
        agentOutcome: 'success',
        verdict: 'fail',
        offendingFindings: [
          { severity: 'P1', summary: 'bug 1', files: ['src/feature/declared.ts'] },
        ],
      })
      .mockResolvedValueOnce({
        invocationId: 'rev-2',
        agentOutcome: 'success',
        verdict: 'fail',
        offendingFindings: [
          { severity: 'P1', summary: 'bug 2', files: ['src/feature/declared.ts'] },
        ],
      })
      .mockResolvedValueOnce({
        invocationId: 'rev-3',
        agentOutcome: 'success',
        verdict: 'fail',
        offendingFindings: [
          { severity: 'P1', summary: 'bug 3', files: ['src/feature/declared.ts'] },
        ],
      });

    vi.mocked(baseDeps.runFix)
      .mockImplementationOnce(async (_ctx, opts) => {
        fixCalls.push(opts);
        return {
          invocationId: 'fix-1',
          agentOutcome: 'success',
          verdict: 'cannot_fix',
          headBeforeFix: 'head-0',
        };
      })
      .mockImplementationOnce(async (_ctx, opts) => {
        fixCalls.push(opts);
        git.headByCwd.set('/tmp/wt', 'head-1');
        git.changedFilesResults.set('head-0|head-1', ['src/undeclared.ts']);
        return {
          invocationId: 'fix-2',
          agentOutcome: 'success',
          verdict: 'done_with_fixes',
          headBeforeFix: 'head-0',
        };
      })
      .mockImplementationOnce(async (_ctx, opts) => {
        fixCalls.push(opts);
        git.headByCwd.set('/tmp/wt', 'head-0');
        return {
          invocationId: 'fix-3',
          agentOutcome: 'success',
          verdict: 'cannot_fix',
          headBeforeFix: 'head-0',
        };
      });

    const loop = new ReviewFixLoop(baseDeps);
    await loop.execute({
      ...baseInput,
      fixFallbackProfile: AgentProfileName('pi-qwen-local'),
      maxIterations: 3,
    });

    expect(fixCalls).toHaveLength(3);
    expect(fixCalls[0]?.useFallback).toBe(false);
    expect(fixCalls[1]?.useFallback).toBe(false);
    expect(fixCalls[2]?.useFallback).toBe(false);

    const escalationEvents = events.filter((e) => e.type === 'phase.fallback.escalated');
    expect(escalationEvents).toHaveLength(0);
  });

  it('rejects fix commit when worktree task-manifest.json is rewritten by fixer to include undeclared file', async () => {
    let worktreeManifestContent = JSON.stringify({
      version: 2,
      task_count: 1,
      tasks: [{ n: 1, title: 'Task 1', expected_files: ['src/feature/declared.ts'] }],
    });

    const depsWithWorktreeFile: ReviewFixLoopDeps = {
      ...baseDeps,
      artifactStore: undefined,
      readWorktreeFile: vi.fn().mockImplementation(async (_cwd, file) => {
        if (file === 'task-manifest.json') return worktreeManifestContent;
        return undefined;
      }),
    };

    const inputWithoutManifest: ReviewFixLoopInput = {
      ...baseInput,
      maxIterations: 1,
      manifest: undefined,
    };

    vi.mocked(depsWithWorktreeFile.runReview).mockResolvedValueOnce({
      invocationId: 'rev-1',
      agentOutcome: 'success',
      verdict: 'fail',
      offendingFindings: [
        { severity: 'P1', summary: 'bug in logic', files: ['src/feature/declared.ts'] },
      ],
    });

    git.headByCwd.set('/tmp/wt', 'head-1');
    git.changedFilesResults.set('head-0|head-1', ['src/undeclared.ts']);

    vi.mocked(depsWithWorktreeFile.runFix).mockImplementationOnce(async () => {
      // Fixer attempts to rewrite task-manifest.json to whitelist undeclared file
      worktreeManifestContent = JSON.stringify({
        version: 2,
        task_count: 1,
        tasks: [
          {
            n: 1,
            title: 'Task 1',
            expected_files: ['src/feature/declared.ts', 'src/undeclared.ts'],
          },
        ],
      });
      return {
        invocationId: 'fix-1',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
        headBeforeFix: 'head-0',
        summary: 'attempted fix with rewritten manifest',
      };
    });

    const loop = new ReviewFixLoop(depsWithWorktreeFile);
    const result = await loop.execute(inputWithoutManifest);

    const boundaryEvents = events.filter((e) => e.type === 'task_boundary.violated');
    expect(boundaryEvents).toHaveLength(1);
    expect(boundaryEvents[0]?.message).toContain(
      'review-fix modified undeclared files: src/undeclared.ts',
    );
    expect(depsWithWorktreeFile.rollbackFix).toHaveBeenCalledWith(
      expect.objectContaining({ iterationIndex: 1 }),
      'head-0',
    );
    expect(result.phaseOutcome).toBe('failed');
  });
});
