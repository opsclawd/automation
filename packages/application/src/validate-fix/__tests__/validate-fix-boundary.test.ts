import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RunId, PhaseName, AgentProfileName } from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { ValidateFixLoop } from '../validate-fix-loop.js';
import { FakeGitPort } from '../../test-doubles/fake-git-port.js';
import { FakeLoopRepository } from '../../test-doubles/fake-loop-repository.js';
import { FakeArtifactStore } from '../../test-doubles/fake-artifact-store.js';
import type { ValidateFixLoopDeps, ValidateFixLoopInput } from '../types.js';
import type { FixStepOptions } from '../../review-fix/types.js';

describe('ValidateFixLoop task boundary enforcement (regression)', () => {
  let events: OrchestratorEvent[];
  let git: FakeGitPort;
  let loops: FakeLoopRepository;
  let artifacts: FakeArtifactStore;
  let baseDeps: ValidateFixLoopDeps;
  let baseInput: ValidateFixLoopInput;

  beforeEach(() => {
    events = [];
    git = new FakeGitPort();
    loops = new FakeLoopRepository();
    artifacts = new FakeArtifactStore();

    baseDeps = {
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
      rollbackFix: vi.fn().mockImplementation(async (_ctx, targetSha) => {
        git.headByCwd.set('/tmp/wt', targetSha);
        return true;
      }),
      git,
      artifactStore: artifacts,
    };

    baseInput = {
      runId: RunId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
      phaseId: PhaseName('fix-validate'),
      repoId: 'acme/widgets',
      cwd: '/tmp/wt',
      maxIterations: 3,
      fixProfile: AgentProfileName('opencode-frontier'),
      manifest: {
        version: 2,
        task_count: 1,
        tasks: [
          {
            n: 1,
            title: 'Task 1',
            expected_files: ['src/declared.ts'],
          },
        ],
      },
    };

    git.headByCwd.set('/tmp/wt', 'head-0');
  });

  it('detects undeclared file changes in fix commit, emits task_boundary.violated, and treats revalidation as failed', async () => {
    git.headByCwd.set('/tmp/wt', 'head-1');
    git.changedFilesResults.set('head-0|head-1', ['src/undeclared.ts']);

    vi.mocked(baseDeps.runFix)
      .mockResolvedValueOnce({
        invocationId: 'fix-1',
        agentOutcome: 'success',
        verdict: 'fixed',
        headBeforeFix: 'head-0',
      })
      .mockResolvedValueOnce({
        invocationId: 'fix-2',
        agentOutcome: 'success',
        verdict: 'no_fixes_needed',
        headBeforeFix: 'head-0',
      });

    const loop = new ValidateFixLoop(baseDeps);
    const _result = await loop.execute(baseInput);

    const boundaryEvents = events.filter((e) => e.type === 'task_boundary.violated');
    expect(boundaryEvents).toHaveLength(1);
    expect(boundaryEvents[0]?.phase).toBe('fix-validate');
    expect(boundaryEvents[0]?.message).toContain(
      'fix-validate modified undeclared files: src/undeclared.ts',
    );
    expect((boundaryEvents[0]?.metadata as { files?: string[] } | undefined)?.files).toEqual([
      'src/undeclared.ts',
    ]);

    expect(baseDeps.rollbackFix).toHaveBeenCalledWith(
      expect.objectContaining({ iterationIndex: 1 }),
      'head-0',
    );
  });

  it('carries boundary violation failure detail into next runFix call through deterministicDiagnostic and allowedFiles', async () => {
    git.headByCwd.set('/tmp/wt', 'head-1');
    git.changedFilesResults.set('head-0|head-1', ['src/undeclared.ts']);

    const fixCalls: FixStepOptions[] = [];
    vi.mocked(baseDeps.runFix)
      .mockImplementationOnce(async (_ctx, opts) => {
        fixCalls.push(opts);
        return {
          invocationId: 'fix-1',
          agentOutcome: 'success',
          verdict: 'fixed',
          headBeforeFix: 'head-0',
        };
      })
      .mockImplementationOnce(async (_ctx, opts) => {
        fixCalls.push(opts);
        git.headByCwd.set('/tmp/wt', 'head-2');
        git.changedFilesResults.set('head-0|head-2', ['src/declared.ts']);
        return {
          invocationId: 'fix-2',
          agentOutcome: 'success',
          verdict: 'fixed',
          headBeforeFix: 'head-0',
        };
      });

    const loop = new ValidateFixLoop(baseDeps);
    const result = await loop.execute(baseInput);

    expect(result.phaseOutcome).toBe('passed');
    expect(fixCalls).toHaveLength(2);
    expect(fixCalls[0]?.deterministicDiagnostic).toBeUndefined();
    expect(fixCalls[0]?.allowedFiles).toEqual(['src/declared.ts']);
    expect(fixCalls[1]?.deterministicDiagnostic).toContain(
      'fix-validate modified undeclared files: src/undeclared.ts',
    );
    expect(fixCalls[1]?.allowedFiles).toEqual(['src/declared.ts']);
  });

  it('allows fix commits touching only declared files to pass revalidation directly', async () => {
    git.headByCwd.set('/tmp/wt', 'head-1');
    git.changedFilesResults.set('head-0|head-1', ['src/declared.ts']);

    vi.mocked(baseDeps.runFix).mockResolvedValueOnce({
      invocationId: 'fix-1',
      agentOutcome: 'success',
      verdict: 'fixed',
      headBeforeFix: 'head-0',
    });

    const loop = new ValidateFixLoop(baseDeps);
    const result = await loop.execute(baseInput);

    expect(result.phaseOutcome).toBe('passed');
    const boundaryEvents = events.filter((e) => e.type === 'task_boundary.violated');
    expect(boundaryEvents).toHaveLength(0);
  });

  it('enforces task boundaries and rolls back when fix verdict is no_fixes_needed but undeclared files are committed', async () => {
    git.headByCwd.set('/tmp/wt', 'head-1');
    git.changedFilesResults.set('head-0|head-1', ['src/undeclared.ts']);

    vi.mocked(baseDeps.runFix)
      .mockResolvedValueOnce({
        invocationId: 'fix-1',
        agentOutcome: 'success',
        verdict: 'no_fixes_needed',
        headBeforeFix: 'head-0',
      })
      .mockResolvedValueOnce({
        invocationId: 'fix-2',
        agentOutcome: 'success',
        verdict: 'no_fixes_needed',
        headBeforeFix: 'head-0',
      });

    // On iteration 2, head does not change
    git.changedFilesResults.set('head-0|head-0', []);

    const loop = new ValidateFixLoop(baseDeps);
    const _result = await loop.execute(baseInput);

    const boundaryEvents = events.filter((e) => e.type === 'task_boundary.violated');
    expect(boundaryEvents).toHaveLength(1);
    expect(baseDeps.rollbackFix).toHaveBeenCalledWith(
      expect.objectContaining({ iterationIndex: 1 }),
      'head-0',
    );
  });

  it('enforces task boundaries and rolls back when fix verdict is cannot_fix but undeclared files are committed', async () => {
    git.headByCwd.set('/tmp/wt', 'head-1');
    git.changedFilesResults.set('head-0|head-1', ['src/undeclared.ts']);

    vi.mocked(baseDeps.runFix)
      .mockResolvedValueOnce({
        invocationId: 'fix-1',
        agentOutcome: 'success',
        verdict: 'cannot_fix',
        headBeforeFix: 'head-0',
      })
      .mockResolvedValueOnce({
        invocationId: 'fix-2',
        agentOutcome: 'success',
        verdict: 'cannot_fix',
        headBeforeFix: 'head-0',
      })
      .mockResolvedValueOnce({
        invocationId: 'fix-3',
        agentOutcome: 'success',
        verdict: 'cannot_fix',
        headBeforeFix: 'head-0',
      });

    const loop = new ValidateFixLoop(baseDeps);
    const _result = await loop.execute(baseInput);

    const boundaryEvents = events.filter((e) => e.type === 'task_boundary.violated');
    expect(boundaryEvents).toHaveLength(1);
    expect(baseDeps.rollbackFix).toHaveBeenCalledWith(
      expect.objectContaining({ iterationIndex: 1 }),
      'head-0',
    );
  });

  it('treats git errors during boundary check as synthetic failure, rolls back, and does not call runRevalidation', async () => {
    git.headCommitSha = vi.fn().mockRejectedValue(new Error('git error: corrupt pack file'));

    vi.mocked(baseDeps.runFix).mockResolvedValue({
      invocationId: 'fix-1',
      agentOutcome: 'success',
      verdict: 'fixed',
      headBeforeFix: 'head-0',
    });

    const loop = new ValidateFixLoop(baseDeps);
    const result = await loop.execute({ ...baseInput, maxIterations: 1 });

    expect(result.phaseOutcome).toBe('failed');
    expect(baseDeps.runRevalidation).not.toHaveBeenCalled();
    const errorEvents = events.filter((e) => e.type === 'task_boundary.check_failed');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]?.level).toBe('warn');
    expect(errorEvents[0]?.message).toContain('git error: corrupt pack file');
    expect((errorEvents[0]?.metadata as { error?: string } | undefined)?.error).toBe(
      'git error: corrupt pack file',
    );
  });

  it('treats missing manifest as synthetic check failure, emits check_failed, rolls back, and does not call runRevalidation', async () => {
    git.headByCwd.set('/tmp/wt', 'head-1');
    git.changedFilesResults.set('head-0|head-1', ['src/anything.ts']);

    const inputWithoutManifest = {
      ...baseInput,
      maxIterations: 1,
      manifest: undefined,
    };

    vi.mocked(baseDeps.runFix).mockResolvedValue({
      invocationId: 'fix-1',
      agentOutcome: 'success',
      verdict: 'fixed',
      headBeforeFix: 'head-0',
    });

    const loop = new ValidateFixLoop(baseDeps);
    const result = await loop.execute(inputWithoutManifest);

    expect(result.phaseOutcome).toBe('failed');
    expect(baseDeps.runRevalidation).not.toHaveBeenCalled();
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

  it('treats malformed manifest in artifactStore as synthetic check failure, distinguishing from missing', async () => {
    git.headByCwd.set('/tmp/wt', 'head-1');
    git.changedFilesResults.set('head-0|head-1', ['src/anything.ts']);

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

    vi.mocked(baseDeps.runFix).mockResolvedValue({
      invocationId: 'fix-1',
      agentOutcome: 'success',
      verdict: 'fixed',
      headBeforeFix: 'head-0',
    });

    const loop = new ValidateFixLoop(baseDeps);
    const result = await loop.execute(inputWithoutManifest);

    expect(result.phaseOutcome).toBe('failed');
    expect(baseDeps.runRevalidation).not.toHaveBeenCalled();
    expect(baseDeps.rollbackFix).toHaveBeenCalled();

    const checkFailedEvents = events.filter((e) => e.type === 'task_boundary.check_failed');
    expect(checkFailedEvents).toHaveLength(1);
    expect(checkFailedEvents[0]?.metadata).toMatchObject({
      reason: 'malformed_manifest',
    });
    expect((checkFailedEvents[0]?.metadata as { error?: string })?.error).toBeTruthy();
  });

  it('resets consecutiveFixFailures on boundary violation to prevent premature fallback escalation', async () => {
    const fixCalls: FixStepOptions[] = [];
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
          verdict: 'fixed',
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

    const loop = new ValidateFixLoop(baseDeps);
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
});
