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
            expected_files: ['src/declared.ts'],
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
      offendingFindings: [{ severity: 'P1', summary: 'bug in logic', files: ['src/declared.ts'] }],
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
          { severity: 'P1', summary: 'bug in logic', files: ['src/declared.ts'] },
        ],
      })
      .mockResolvedValueOnce({
        invocationId: 'rev-2',
        agentOutcome: 'success',
        verdict: 'pass',
        offendingFindings: [],
      });

    // Iteration 1 fixer touches undeclared file -> violation
    git.headByCwd.set('/tmp/wt', 'head-1');
    git.changedFilesResults.set('head-0|head-1', ['src/undeclared.ts']);

    // Iteration 2 fixer touches declared file -> success
    git.changedFilesResults.set('head-0|head-2', ['src/declared.ts']);

    vi.mocked(baseDeps.runFix)
      .mockResolvedValueOnce({
        invocationId: 'fix-1',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
        headBeforeFix: 'head-0',
        summary: 'attempt 1 with undeclared file',
      })
      .mockResolvedValueOnce({
        invocationId: 'fix-2',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
        headBeforeFix: 'head-0',
        summary: 'attempt 2 with declared file',
      });

    const loop = new ReviewFixLoop(baseDeps);
    const result = await loop.execute({
      ...baseInput,
      maxIterations: 2,
    });

    expect(result.phaseOutcome).toBe('passed');
    expect(result.loop.iterations[0]?.outcome).toBe('unresolved');
    expect(result.loop.iterations[1]?.outcome).toBe('resolved');
    expect(events.filter((e) => e.type === 'task_boundary.violated')).toHaveLength(1);
  });

  it('reports whole-pr-fix-review phase name in task_boundary.violated when phaseId is whole-pr-fix-review', async () => {
    vi.mocked(baseDeps.runReview).mockResolvedValueOnce({
      invocationId: 'rev-1',
      agentOutcome: 'success',
      verdict: 'fail',
      offendingFindings: [{ severity: 'P1', summary: 'bug in logic', files: ['src/declared.ts'] }],
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
          { severity: 'P1', summary: 'bug in logic', files: ['src/declared.ts'] },
        ],
      })
      .mockResolvedValueOnce({
        invocationId: 'rev-2',
        agentOutcome: 'success',
        verdict: 'pass',
        offendingFindings: [],
      });

    git.headByCwd.set('/tmp/wt', 'head-1');
    git.changedFilesResults.set('head-0|head-1', ['src/declared.ts']);

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
});
