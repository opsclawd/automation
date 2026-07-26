import { describe, it, expect, vi } from 'vitest';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { ImplementHandler } from '../implement.js';
import type { StepRunContext, StepRunResult } from '../implement.js';
import { RunId } from '@ai-sdlc/domain';
import { FakeArtifactStore } from '../../../test-doubles/fake-artifact-store.js';
import { FakeStepRepository } from '../../../test-doubles/fake-step-repository.js';
import { FakeGitPort } from '../../../test-doubles/fake-git-port.js';
import type { PhaseHandlerContext } from '../../handler.js';

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

function planMd(tasks: string[]): string {
  return ['# Plan', '', ...tasks.map((t) => `## ${t}`), '', '## Notes', 'Extra.'].join('\n');
}

describe('ImplementHandler Commit Coverage', () => {
  it('committed V2 expected files allow step completion', async () => {
    const artifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    const manifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1: do something',
          expected_files: ['src/a.ts', 'src/b.ts'],
        },
      ],
    };
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: do something']),
    });
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'task-manifest.json',
      contents: JSON.stringify(manifest),
    });

    const steps = new FakeStepRepository();
    const { ctx, events } = makeCtx(artifacts, git);

    git.headByCwd.set(ctx.cwd, 'pre-step');
    git.changedFilesResults.set('pre-step|post-step', ['src/a.ts', 'src/b.ts']);

    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      git.headByCwd.set(ctx.cwd, 'post-step');
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({ steps, runStep }).run(ctx);

    expect(result.outcome).toBe('passed');
    const all = steps.listForRun(RunId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe('success');

    const completed = events.filter((e) => e.type === 'step.completed');
    expect(completed).toHaveLength(1);
  });

  it('missing V2 expected file fails the step before completion', async () => {
    const artifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    const manifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1: do something',
          expected_files: ['src/a.ts', 'src/b.ts'],
        },
      ],
    };
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: do something']),
    });
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'task-manifest.json',
      contents: JSON.stringify(manifest),
    });

    const steps = new FakeStepRepository();
    const { ctx, events } = makeCtx(artifacts, git);

    git.headByCwd.set(ctx.cwd, 'pre-step');
    git.changedFilesResults.set('pre-step|post-step', ['src/a.ts']);

    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      git.headByCwd.set(ctx.cwd, 'post-step');
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({ steps, runStep }).run(ctx);

    expect(result.outcome).toBe('failed');
    const all = steps.listForRun(RunId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe('failed');

    const uncommitted = events.filter((e) => e.type === 'step.uncommitted_files');
    expect(uncommitted).toHaveLength(1);
    expect(uncommitted[0]?.metadata).toMatchObject({
      expectedFiles: ['src/a.ts', 'src/b.ts'],
      committedFiles: ['src/a.ts'],
      missingFiles: ['src/b.ts'],
      preStepHead: 'pre-step',
      postStepHead: 'post-step',
    });

    const failed = events.filter((e) => e.type === 'step.failed');
    expect(failed).toHaveLength(1);

    const completed = events.filter((e) => e.type === 'step.completed');
    expect(completed).toHaveLength(0);
  });

  it('legacy V1 files are verified', async () => {
    const artifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    const manifest = {
      version: 1,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1: legacy v1',
          files: ['src/v1.ts'],
        },
      ],
    };
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: legacy v1']),
    });
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'task-manifest.json',
      contents: JSON.stringify(manifest),
    });

    const steps = new FakeStepRepository();
    const { ctx, events } = makeCtx(artifacts, git);

    git.headByCwd.set(ctx.cwd, 'pre-step');
    git.changedFilesResults.set('pre-step|post-step', []);

    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      git.headByCwd.set(ctx.cwd, 'post-step');
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({ steps, runStep }).run(ctx);

    expect(result.outcome).toBe('failed');
    const uncommitted = events.filter((e) => e.type === 'step.uncommitted_files');
    expect(uncommitted).toHaveLength(1);
    expect(uncommitted[0]?.metadata).toMatchObject({
      expectedFiles: ['src/v1.ts'],
      missingFiles: ['src/v1.ts'],
    });
  });

  it('V2 expected_files and files are merged and normalized', async () => {
    const artifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    const manifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1: merge fields',
          expected_files: ['src\\a.ts ', 'src/b.ts'],
          files: ['src/b.ts', 'src/c.ts', ''],
        },
      ],
    };
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: merge fields']),
    });
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'task-manifest.json',
      contents: JSON.stringify(manifest),
    });

    const steps = new FakeStepRepository();
    const { ctx } = makeCtx(artifacts, git);

    git.headByCwd.set(ctx.cwd, 'pre-step');
    git.changedFilesResults.set('pre-step|post-step', ['src/a.ts', 'src/b.ts', 'src/c.ts']);

    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      git.headByCwd.set(ctx.cwd, 'post-step');
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({ steps, runStep }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(git.changedFilesCalls).toHaveLength(1);
  });

  it('tasks without declared files skip commit coverage verification', async () => {
    const artifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    const manifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1: no declared files',
        },
      ],
    };
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: no declared files']),
    });
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'task-manifest.json',
      contents: JSON.stringify(manifest),
    });

    const steps = new FakeStepRepository();
    const { ctx, events } = makeCtx(artifacts, git);

    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({ steps, runStep }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(git.changedFilesCalls).toHaveLength(0);
    const completed = events.filter((e) => e.type === 'step.completed');
    expect(completed).toHaveLength(1);
  });

  it('commit coverage query failure fails closed', async () => {
    const artifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    const manifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1: query fails',
          expected_files: ['src/a.ts'],
        },
      ],
    };
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: query fails']),
    });
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'task-manifest.json',
      contents: JSON.stringify(manifest),
    });

    const steps = new FakeStepRepository();
    const { ctx, events } = makeCtx(artifacts, git);

    git.headByCwd.set(ctx.cwd, 'pre-step');
    git.changedFiles = vi.fn().mockRejectedValue(new Error('Git command failed'));

    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      git.headByCwd.set(ctx.cwd, 'post-step');
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({ steps, runStep }).run(ctx);

    expect(result.outcome).toBe('failed');
    const all = steps.listForRun(RunId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe('failed');

    const uncommitted = events.filter((e) => e.type === 'step.uncommitted_files');
    expect(uncommitted).toHaveLength(1);
    expect(uncommitted[0]?.metadata).toMatchObject({
      error: 'Git command failed',
    });

    const failed = events.filter((e) => e.type === 'step.failed');
    expect(failed).toHaveLength(1);
  });

  it('resumed step uses a fresh per-attempt baseline', async () => {
    const artifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    const manifest = {
      version: 2,
      task_count: 2,
      tasks: [
        {
          n: 1,
          title: 'Task 1: already done',
          expected_files: ['src/step1.ts'],
        },
        {
          n: 2,
          title: 'Task 2: to do',
          expected_files: ['src/step2.ts'],
        },
      ],
    };
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: already done', 'Task 2: to do']),
    });
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'task-manifest.json',
      contents: JSON.stringify(manifest),
    });

    const steps = new FakeStepRepository();
    steps.upsert({
      id: 'step-1',
      runId: RunId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
      phaseId: 'implement',
      index: 1,
      title: 'Task 1: already done',
      status: 'success',
      startedAt: new Date(),
      completedAt: new Date(),
    });

    const { ctx } = makeCtx(artifacts, git);

    // Initial HEAD before step 2 runs
    git.headByCwd.set(ctx.cwd, 'head-before-step-2');
    git.changedFilesResults.set('head-before-step-2|head-after-step-2', ['src/step2.ts']);

    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      git.headByCwd.set(ctx.cwd, 'head-after-step-2');
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({ steps, runStep }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(runStep).toHaveBeenCalledTimes(1);
    expect(git.changedFilesCalls).toEqual([
      { cwd: '/tmp/wt', base: 'head-before-step-2', head: 'head-after-step-2' },
    ]);
  });

  it('reference_files are excluded from commit coverage', async () => {
    const artifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: use a reference']),
    });
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'task-manifest.json',
      contents: JSON.stringify({
        version: 2,
        task_count: 1,
        tasks: [
          {
            n: 1,
            title: 'Task 1: use a reference',
            expected_files: ['src/changed.ts'],
            reference_files: ['src/read-only.ts'],
          },
        ],
      }),
    });

    const steps = new FakeStepRepository();
    const { ctx, events } = makeCtx(artifacts, git);
    git.headByCwd.set(ctx.cwd, 'pre-step');
    git.changedFilesResults.set('pre-step|post-step', ['src/changed.ts']);
    const runStep = vi.fn(async (): Promise<StepRunResult> => {
      git.headByCwd.set(ctx.cwd, 'post-step');
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({ steps, runStep }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(events.some((event) => event.type === 'step.completed')).toBe(true);
    expect(events.some((event) => event.type === 'step.uncommitted_files')).toBe(false);
  });

  it('expected_files with not_modified signature change remains required for commit coverage', async () => {
    const artifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: unmodified signature in expected_files']),
    });
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'task-manifest.json',
      contents: JSON.stringify({
        version: 2,
        task_count: 1,
        tasks: [
          {
            n: 1,
            title: 'Task 1: unmodified signature in expected_files',
            expected_files: ['src/reference-only.ts'],
            signature_changes: [
              { declaration_file: 'src/reference-only.ts', symbol: 'foo', change: 'not_modified' },
            ],
          },
        ],
      }),
    });

    const steps = new FakeStepRepository();
    const { ctx, events } = makeCtx(artifacts, git);
    git.headByCwd.set(ctx.cwd, 'pre-step');
    git.changedFilesResults.set('pre-step|post-step', []);

    const runStep = vi.fn(async (): Promise<StepRunResult> => {
      git.headByCwd.set(ctx.cwd, 'post-step');
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({ steps, runStep }).run(ctx);

    expect(result.outcome).toBe('failed');
    const uncommitted = events.filter((e) => e.type === 'step.uncommitted_files');
    expect(uncommitted).toHaveLength(1);
    expect(uncommitted[0]?.metadata).toMatchObject({
      expectedFiles: ['src/reference-only.ts'],
      missingFiles: ['src/reference-only.ts'],
    });
  });
});
