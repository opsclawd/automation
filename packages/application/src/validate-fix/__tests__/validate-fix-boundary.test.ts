import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RunId, PhaseName, AgentProfileName } from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { ValidateFixLoop } from '../validate-fix-loop.js';
import { FakeGitPort } from '../../test-doubles/fake-git-port.js';
import { FakeLoopRepository } from '../../test-doubles/fake-loop-repository.js';
import { FakeArtifactStore } from '../../test-doubles/fake-artifact-store.js';
import type { ValidateFixLoopDeps, ValidateFixLoopInput } from '../types.js';

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
      rollbackFix: vi.fn().mockResolvedValue(true),
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
});
