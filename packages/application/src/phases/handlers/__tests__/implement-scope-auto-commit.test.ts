import { describe, it, expect, vi } from 'vitest';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { ImplementHandler } from '../implement.js';
import type { StepRunContext, StepRunResult } from '../implement.js';
import { FakeArtifactStore } from '../../../test-doubles/fake-artifact-store.js';
import { FakeStepRepository } from '../../../test-doubles/fake-step-repository.js';
import { FakeGitPort } from '../../../test-doubles/fake-git-port.js';
import type { PhaseHandlerContext } from '../../handler.js';

function planMd(tasks: string[]): string {
  return ['# Plan', '', ...tasks.map((t) => `## ${t}`), '', '## Notes', 'Extra.'].join('\n');
}

function makeCtx(artifacts: FakeArtifactStore, git: FakeGitPort) {
  const events: OrchestratorEvent[] = [];
  const now = () => new Date('2026-06-16T00:00:00Z');
  const ctx = {
    runId: 'run-1',
    runUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    repoFullName: 'acme/widgets',
    issueNumber: 42,
    cwd: '/tmp/wt',
    artifacts,
    github: {} as PhaseHandlerContext['github'],
    git,
    agent: {} as PhaseHandlerContext['agent'],
    events: {
      publish: (_u: string, e: OrchestratorEvent) => {
        events.push(e);
      },
      subscribe: () => () => {},
    },
    now,
    idFactory: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
  } satisfies PhaseHandlerContext;
  return { ctx, events };
}

interface SetupOptions {
  taskTitle?: string;
  expectedFiles?: string[];
  mayExtend?: string[];
  permittedAreas?: string[];
  tasks?: Array<{
    n: number;
    title: string;
    expected_files?: string[];
    may_extend?: string[];
    permitted_areas?: string[];
  }>;
}

async function setupHarness(options: SetupOptions = {}) {
  const taskTitle = options.taskTitle ?? 'Task 1: do something';
  const expectedFiles = options.expectedFiles ?? ['src/feature.ts'];
  const mayExtend = options.mayExtend;
  const permittedAreas = options.permittedAreas;
  const artifacts = new FakeArtifactStore();
  const git = new FakeGitPort();

  const manifestTasks = options.tasks ?? [
    {
      n: 1,
      title: taskTitle,
      expected_files: expectedFiles,
      ...(mayExtend !== undefined ? { may_extend: mayExtend } : {}),
      ...(permittedAreas !== undefined ? { permitted_areas: permittedAreas } : {}),
    },
  ];

  const manifest = {
    version: 2,
    task_count: manifestTasks.length,
    tasks: manifestTasks,
  };

  await artifacts.write({
    runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    relativePath: 'plan.md',
    contents: planMd(manifestTasks.map((t) => t.title)),
  });
  await artifacts.write({
    runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    relativePath: 'task-manifest.json',
    contents: JSON.stringify(manifest),
  });

  const steps = new FakeStepRepository();
  const { ctx, events } = makeCtx(artifacts, git);

  git.headByCwd.set(ctx.cwd, 'pre-step');

  return {
    artifacts,
    git,
    steps,
    ctx,
    events,
    taskTitle,
    expectedFiles,
    mayExtend,
    permittedAreas,
    manifestTasks,
  };
}

describe('ImplementHandler Scope-Aware Auto-Commit', () => {
  it('auto-commits dirty expected may_extend and tracked permitted-area candidates together', async () => {
    const { git, steps, ctx, events, taskTitle } = await setupHarness({
      expectedFiles: ['src/feature.ts'],
      mayExtend: ['src/client.ts'],
      permittedAreas: ['src/helpers'],
    });

    git.status = vi.fn(async () => {
      const committed =
        git.commits.some((c) => c.files?.includes('src/feature.ts')) &&
        git.commits.some((c) => c.files?.includes('src/client.ts')) &&
        git.commits.some((c) => c.files?.includes('src/helpers/util.ts'));
      return committed ? '' : ' M src/feature.ts\n M src/client.ts\n M src/helpers/util.ts';
    });
    git.changedFilesResults.set('pre-step|pre-step', []);
    git.changedFilesResults.set('pre-step|fake-sha-1', [
      'src/client.ts',
      'src/feature.ts',
      'src/helpers/util.ts',
    ]);
    git.createdFilesResults.set('pre-step|pre-step', []);
    git.createdFilesResults.set('pre-step|fake-sha-1', []);

    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 1,
    }).run(ctx);

    expect(git.addCalls).toEqual([
      {
        cwd: '/tmp/wt',
        files: ['src/client.ts', 'src/feature.ts', 'src/helpers/util.ts'],
      },
    ]);
    expect(git.commits[0]).toEqual({
      cwd: '/tmp/wt',
      message: taskTitle,
      sha: 'fake-sha-1',
      files: ['src/client.ts', 'src/feature.ts', 'src/helpers/util.ts'],
    });
    expect(runStep).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === 'step.declared_files_retry')).toHaveLength(0);
    expect(result.outcome).toBe('passed');
  });

  it('passes only classifier-approved concrete paths to git add and commit', async () => {
    const { git, steps, ctx } = await setupHarness({
      expectedFiles: ['src/core/main.ts'],
      permittedAreas: ['src/core'],
    });

    git.status = vi.fn(async () => {
      const committed = git.commits.some((c) => c.files?.includes('src/core/main.ts'));
      return committed
        ? '?? unpermitted.ts'
        : ' M src/core/main.ts\n M src/core/extra.ts\n?? unpermitted.ts';
    });
    git.changedFilesResults.set('pre-step|pre-step', []);
    git.changedFilesResults.set('pre-step|fake-sha-1', ['src/core/extra.ts', 'src/core/main.ts']);
    git.createdFilesResults.set('pre-step|pre-step', []);
    git.createdFilesResults.set('pre-step|fake-sha-1', []);

    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      return { outcome: 'success' };
    });

    await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 0,
    }).run(ctx);

    expect(git.addCalls).toHaveLength(1);
    expect(git.addCalls[0]?.files).toEqual(['src/core/extra.ts', 'src/core/main.ts']);
    expect(git.commits).toHaveLength(1);
    expect(git.commits[0]?.files).toEqual(['src/core/extra.ts', 'src/core/main.ts']);

    for (const call of git.addCalls) {
      expect(call.files).not.toContain('src/core');
      expect(call.files).not.toContain('unpermitted.ts');
    }
    for (const commit of git.commits) {
      expect(commit.files).not.toContain('src/core');
      expect(commit.files).not.toContain('unpermitted.ts');
    }
  });

  it('does not stage an untracked file authorized only by permitted_areas', async () => {
    const { git, steps, ctx, events } = await setupHarness({
      expectedFiles: ['src/feature.ts'],
      permittedAreas: ['src'],
    });

    git.status = vi.fn(async () => {
      const featureCommitted = git.commits.some((c) => c.files?.includes('src/feature.ts'));
      return featureCommitted ? '?? src/untracked.ts' : ' M src/feature.ts\n?? src/untracked.ts';
    });
    git.changedFilesResults.set('pre-step|pre-step', []);
    git.changedFilesResults.set('pre-step|fake-sha-1', ['src/feature.ts']);

    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 0,
    }).run(ctx);

    for (const call of git.addCalls) {
      expect(call.files).not.toContain('src/untracked.ts');
    }
    for (const commit of git.commits) {
      expect(commit.files).not.toContain('src/untracked.ts');
    }
    expect(events.filter((e) => e.type === 'step.completed')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'step.failed')).toHaveLength(1);
    expect(result.outcome).toBe('failed');
  });

  it('does not stage a downstream expected file even under a current permitted area', async () => {
    const { git, steps, ctx, events } = await setupHarness({
      tasks: [
        {
          n: 1,
          title: 'Task 1: first task',
          expected_files: ['src/task1.ts'],
          permitted_areas: ['src'],
        },
        {
          n: 2,
          title: 'Task 2: downstream task',
          expected_files: ['src/task2.ts'],
        },
      ],
    });

    let currentStep = 1;
    let task1Attempt = 0;
    git.status = vi.fn(async () => {
      const task1Committed = git.commits.some((c) => c.files?.includes('src/task1.ts'));
      const task2Committed = git.commits.some((c) => c.files?.includes('src/task2.ts'));
      if (currentStep === 1) {
        if (task1Committed) {
          return task1Attempt === 1 ? ' M src/task2.ts' : '';
        }
        return ' M src/task1.ts\n M src/task2.ts';
      } else {
        return task2Committed ? '' : ' M src/task2.ts';
      }
    });
    git.changedFilesResults.set('pre-step|pre-step', []);
    git.changedFilesResults.set('pre-step|fake-sha-1', ['src/task1.ts']);
    git.changedFilesResults.set('fake-sha-1|fake-sha-2', ['src/task2.ts']);
    git.createdFilesResults.set('pre-step|pre-step', []);
    git.createdFilesResults.set('pre-step|fake-sha-1', []);
    git.createdFilesResults.set('fake-sha-1|fake-sha-2', []);

    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      currentStep = _sctx.stepIndex;
      if (_sctx.stepIndex === 1) {
        task1Attempt += 1;
      }
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 1,
    }).run(ctx);

    expect(git.addCalls[0]?.files).toEqual(['src/task1.ts']);
    expect(git.commits[0]?.files).toEqual(['src/task1.ts']);
    for (const file of git.addCalls[0]?.files ?? []) {
      expect(file).not.toBe('src/task2.ts');
    }
    for (const file of git.commits[0]?.files ?? []) {
      expect(file).not.toBe('src/task2.ts');
    }
    expect(git.addCalls[1]?.files).toEqual(['src/task2.ts']);
    expect(git.commits[1]?.files).toEqual(['src/task2.ts']);
    expect(events.filter((e) => e.type === 'step.declared_files_retry')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'step.completed')).toHaveLength(2);
    expect(result.outcome).toBe('passed');
  });

  it('refreshes head diff and status then recomputes missing and blocking findings after auto-commit', async () => {
    const { git, steps, ctx, events } = await setupHarness({
      expectedFiles: ['src/feature.ts'],
    });

    let statusQueryCount = 0;
    git.status = vi.fn(async () => {
      statusQueryCount += 1;
      const committed = git.commits.some((c) => c.files?.includes('src/feature.ts'));
      return committed ? '?? src/extra.ts' : ' M src/feature.ts\n?? src/extra.ts';
    });
    git.changedFilesResults.set('pre-step|pre-step', []);
    git.changedFilesResults.set('pre-step|fake-sha-1', ['src/feature.ts']);

    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 0,
    }).run(ctx);

    expect(statusQueryCount).toBeGreaterThanOrEqual(2);
    expect(git.changedFilesCalls.some((c) => c.head === 'fake-sha-1')).toBe(true);
    expect(events.filter((e) => e.type === 'step.completed')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'step.failed')).toHaveLength(1);
    expect(result.outcome).toBe('failed');
  });

  it('may_extend and area edits never satisfy a missing expected deliverable', async () => {
    const { steps, ctx, events } = await setupHarness({
      expectedFiles: ['src/required.ts'],
      mayExtend: ['src/optional.ts'],
      permittedAreas: ['src/helpers'],
    });

    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 0,
    }).run(ctx);

    expect(events.filter((e) => e.type === 'step.uncommitted_files')).toHaveLength(1);
    expect(
      (events.find((e) => e.type === 'step.uncommitted_files')?.metadata as Record<string, unknown>)
        ?.missingFiles,
    ).toEqual(['src/required.ts']);
    expect(result.outcome).toBe('failed');
  });

  it('triggers step retry when unpermitted dirty file skipped by auto-commit is left in worktree', async () => {
    const { git, steps, ctx, events } = await setupHarness({
      expectedFiles: ['src/feature.ts'],
    });

    let attempt = 0;
    git.status = vi.fn(async () => {
      const committed = git.commits.some((c) => c.files?.includes('src/feature.ts'));
      if (committed) {
        return attempt === 1 ? '?? unpermitted-extra.ts' : '';
      }
      return ' M src/feature.ts\n?? unpermitted-extra.ts';
    });
    git.changedFilesResults.set('pre-step|pre-step', []);
    git.changedFilesResults.set('pre-step|fake-sha-1', ['src/feature.ts']);

    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      attempt += 1;
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 1,
    }).run(ctx);

    expect(runStep).toHaveBeenCalledTimes(2);
    expect(git.addCalls[0]?.files).toEqual(['src/feature.ts']);
    expect(git.commits[0]?.files).toEqual(['src/feature.ts']);
    expect(events.filter((e) => e.type === 'step.declared_files_retry')).toHaveLength(1);
    const retryEvent = events.find((e) => e.type === 'step.declared_files_retry');
    expect((retryEvent?.metadata as Record<string, unknown>)?.undeclaredFiles).toEqual([
      'unpermitted-extra.ts',
    ]);
    expect(events.filter((e) => e.type === 'step.completed')).toHaveLength(1);
    expect(result.outcome).toBe('passed');
  });

  it('triggers manifest fault when uncommitted dirty reference file is left in worktree', async () => {
    const artifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    const manifestTasks = [
      {
        n: 1,
        title: 'Task 1: modify feature with reference file',
        expected_files: ['src/feature.ts'],
        reference_files: ['src/readonly-ref.ts'],
      },
    ];

    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(manifestTasks.map((t) => t.title)),
    });
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'task-manifest.json',
      contents: JSON.stringify({
        version: 2,
        task_count: manifestTasks.length,
        tasks: manifestTasks,
      }),
    });

    const steps = new FakeStepRepository();
    const { ctx, events } = makeCtx(artifacts, git);
    git.headByCwd.set(ctx.cwd, 'pre-step');

    git.status = vi.fn(async () => {
      const committed = git.commits.some((c) => c.files?.includes('src/feature.ts'));
      return committed ? ' M src/readonly-ref.ts' : ' M src/feature.ts\n M src/readonly-ref.ts';
    });
    git.changedFilesResults.set('pre-step|pre-step', []);
    git.changedFilesResults.set('pre-step|fake-sha-1', ['src/feature.ts']);

    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 1,
    }).run(ctx);

    expect(runStep).toHaveBeenCalledTimes(1);
    expect(git.addCalls[0]?.files).toEqual(['src/feature.ts']);
    expect(git.commits[0]?.files).toEqual(['src/feature.ts']);
    expect(events.filter((e) => e.type === 'step.needs_human_review')).toHaveLength(1);
    expect(result.outcome).toBe('needs_human_review');
    if (result.outcome === 'needs_human_review') {
      expect(result.failure.artifacts).toEqual(['task-manifest.json']);
      expect(result.failure.message).toContain('modified reference_files src/readonly-ref.ts');
    }
  });

  it('does not auto-commit staged newly added files (A, AM,  A) in permitted areas', async () => {
    const { git, steps, ctx, events } = await setupHarness({
      expectedFiles: ['src/feature.ts'],
      permittedAreas: ['src/helpers'],
    });

    git.status = vi.fn(async () => {
      const featureCommitted = git.commits.some((c) => c.files?.includes('src/feature.ts'));
      return featureCommitted
        ? 'A  src/helpers/new-helper.ts'
        : ' M src/feature.ts\nA  src/helpers/new-helper.ts';
    });
    git.changedFilesResults.set('pre-step|pre-step', []);
    git.changedFilesResults.set('pre-step|fake-sha-1', ['src/feature.ts']);

    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 0,
    }).run(ctx);

    expect(git.addCalls[0]?.files).toEqual(['src/feature.ts']);
    expect(git.commits[0]?.files).toEqual(['src/feature.ts']);
    for (const call of git.addCalls) {
      expect(call.files).not.toContain('src/helpers/new-helper.ts');
    }
    for (const commit of git.commits) {
      expect(commit.files).not.toContain('src/helpers/new-helper.ts');
    }
    expect(events.filter((e) => e.type === 'step.completed')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'step.failed')).toHaveLength(1);
    expect(result.outcome).toBe('failed');
  });

  it('safely treats committed files in permitted_areas as untracked drift when createdFiles fails', async () => {
    const { git, steps, ctx, events } = await setupHarness({
      expectedFiles: ['src/feature.ts'],
      permittedAreas: ['src/helpers'],
    });

    git.status = vi.fn(async () => '');
    git.changedFilesResults.set('pre-step|fake-sha-1', [
      'src/feature.ts',
      'src/helpers/undeclared.ts',
    ]);
    git.headByCwd.set(ctx.cwd, 'fake-sha-1');

    // Simulate createdFiles throwing / being unavailable
    git.createdFiles = vi.fn(async () => {
      throw new Error('git created-files failed');
    });

    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 0,
    }).run(ctx);

    // Because createdFiles threw, undeclared.ts in permitted_areas is not assumed tracked, so it is drift
    expect(events.filter((e) => e.type === 'step.completed')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'step.failed')).toHaveLength(1);
    expect(result.outcome).toBe('failed');
  });
});
