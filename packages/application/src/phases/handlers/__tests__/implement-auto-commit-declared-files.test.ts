import { describe, it, expect, vi } from 'vitest';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { ImplementHandler } from '../implement.js';
import type { StepRunContext, StepRunResult } from '../implement.js';
import { FakeArtifactStore } from '../../../test-doubles/fake-artifact-store.js';
import { FakeStepRepository } from '../../../test-doubles/fake-step-repository.js';
import { FakeGitPort } from '../../../test-doubles/fake-git-port.js';
import type { PhaseHandlerContext } from '../../handler.js';

type SelectiveGitFake = FakeGitPort & {
  add: (cwd: string, files: string[]) => Promise<void>;
};

function installSelectiveAdd(git: FakeGitPort) {
  const add = vi.fn(async (_cwd: string, _files: string[]) => undefined);
  Object.assign(git, { add });
  return { git: git as SelectiveGitFake, add };
}

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
}

async function setupHarness(options: SetupOptions = {}) {
  const taskTitle = options.taskTitle ?? 'Task 1: do something';
  const expectedFiles = options.expectedFiles ?? ['src/a.ts', 'src/b.ts'];
  const artifacts = new FakeArtifactStore();
  const rawGit = new FakeGitPort();
  const { git, add } = installSelectiveAdd(rawGit);

  const manifest = {
    version: 2,
    task_count: 1,
    tasks: [
      {
        n: 1,
        title: taskTitle,
        expected_files: expectedFiles,
      },
    ],
  };

  await artifacts.write({
    runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    relativePath: 'plan.md',
    contents: planMd([taskTitle]),
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
    add,
    steps,
    ctx,
    events,
    taskTitle,
    expectedFiles,
  };
}

describe('ImplementHandler Auto-Commit Declared Files State Machine', () => {
  it('auto-commits the remaining tracked declared files and excludes unrelated dirty paths', async () => {
    const { git, add, steps, ctx, events, taskTitle } = await setupHarness({
      expectedFiles: ['src/a.ts', 'src/b.ts'],
    });

    git.statusByCwd.set(ctx.cwd, ' M src/b.ts\n M scratch.md');
    git.changedFilesResults.set('pre-step|agent-step', ['src/a.ts']);
    git.changedFilesResults.set('pre-step|fake-sha-1', ['src/a.ts', 'src/b.ts']);

    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      git.headByCwd.set(ctx.cwd, 'agent-step');
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 1,
    }).run(ctx);

    expect(add).toHaveBeenCalledWith('/tmp/wt', ['src/b.ts']);
    expect(git.commits).toEqual([
      {
        cwd: '/tmp/wt',
        message: taskTitle,
        sha: 'fake-sha-1',
      },
    ]);
    expect(runStep).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === 'step.declared_files_retry')).toHaveLength(0);
    expect(result.outcome).toBe('passed');
  });

  it('auto-commits an untracked declared file inside a new directory', async () => {
    const { git, add, steps, ctx, events, taskTitle } = await setupHarness({
      expectedFiles: ['docs/adr/0001.md'],
    });

    git.statusByCwd.set(ctx.cwd, '?? docs/adr/0001.md\n?? scratch.md');
    git.changedFilesResults.set('pre-step|pre-step', []);
    git.changedFilesResults.set('pre-step|fake-sha-1', ['docs/adr/0001.md']);

    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 1,
    }).run(ctx);

    expect(add).toHaveBeenCalledWith('/tmp/wt', ['docs/adr/0001.md']);
    expect(git.commits).toEqual([
      {
        cwd: '/tmp/wt',
        message: taskTitle,
        sha: 'fake-sha-1',
      },
    ]);
    expect(runStep).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === 'step.declared_files_retry')).toHaveLength(0);
    expect(result.outcome).toBe('passed');
  });

  it('does not create a second commit when the agent already committed every declared file', async () => {
    const { git, add, steps, ctx, events } = await setupHarness({
      expectedFiles: ['src/a.ts', 'src/b.ts'],
    });

    git.statusByCwd.set(ctx.cwd, '');

    let agentSha = '';
    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      agentSha = await git.commit(ctx.cwd, 'feat: agent committed everything');
      git.changedFilesResults.set(`pre-step|${agentSha}`, ['src/a.ts', 'src/b.ts']);
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 1,
    }).run(ctx);

    expect(add).not.toHaveBeenCalled();
    expect(git.commits).toEqual([
      {
        cwd: '/tmp/wt',
        message: 'feat: agent committed everything',
        sha: agentSha,
      },
    ]);
    expect(runStep).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === 'step.declared_files_retry')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'step.completed')).toHaveLength(1);
    expect(result.outcome).toBe('passed');
  });

  it('does not auto-commit when only some missing declared files are dirty', async () => {
    const { git, add, steps, ctx, events } = await setupHarness({
      expectedFiles: ['src/a.ts', 'src/b.ts'],
    });

    git.statusByCwd.set(ctx.cwd, ' M src/a.ts');
    git.changedFilesResults.set('pre-step|pre-step', []);

    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 1,
    }).run(ctx);

    expect(add).not.toHaveBeenCalled();
    expect(git.commits).toHaveLength(0);
    expect(runStep).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.type === 'step.declared_files_retry')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'step.uncommitted_files')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'step.failed')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'step.completed')).toHaveLength(0);
    expect(result.outcome).toBe('failed');
  });

  it('does not auto-commit a genuinely absent declared file and preserves the retry budget', async () => {
    const { git, add, steps, ctx, events } = await setupHarness({
      expectedFiles: ['src/a.ts', 'src/b.ts'],
    });

    git.statusByCwd.set(ctx.cwd, '');
    git.changedFilesResults.set('pre-step|pre-step', []);

    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 1,
    }).run(ctx);

    expect(add).not.toHaveBeenCalled();
    expect(git.commits).toHaveLength(0);
    expect(runStep).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.type === 'step.declared_files_retry')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'step.uncommitted_files')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'step.failed')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'step.completed')).toHaveLength(0);
    expect(result.outcome).toBe('failed');
  });

  it('keeps the #869 guard active when the auto-commit does not add commit coverage', async () => {
    const { git, steps, ctx, events } = await setupHarness({
      expectedFiles: ['src/a.ts'],
    });

    git.statusByCwd.set(ctx.cwd, ' M src/a.ts');
    git.changedFilesResults.set('pre-step|pre-step', []);
    git.changedFilesResults.set('pre-step|fake-sha-1', []);
    git.changedFilesResults.set('pre-step|fake-sha-2', []);

    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 1,
    }).run(ctx);

    expect(runStep).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.type === 'step.completed')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'step.declared_files_retry')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'step.uncommitted_files')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'step.failed')).toHaveLength(1);
    expect(result.outcome).toBe('failed');
  });

  it('does not auto-commit when status cannot prove every missing declaration is dirty', async () => {
    const { git, add, steps, ctx, events } = await setupHarness({
      expectedFiles: ['src/a.ts'],
    });

    git.status = vi.fn().mockRejectedValue(new Error('git status failed'));
    git.changedFilesResults.set('pre-step|pre-step', []);

    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 1,
    }).run(ctx);

    expect(add).not.toHaveBeenCalled();
    expect(git.commits).toHaveLength(0);
    expect(runStep).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.type === 'step.unaffected_files_verified')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'step.declared_files_retry')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'step.uncommitted_files')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'step.failed')).toHaveLength(1);
    expect(result.outcome).toBe('failed');
  });
});
