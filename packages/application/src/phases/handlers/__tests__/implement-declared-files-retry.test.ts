import { describe, it, expect, vi } from 'vitest';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { ImplementHandler } from '../implement.js';
import type { StepRunContext, StepRunResult } from '../implement.js';
import { FakeArtifactStore } from '../../../test-doubles/fake-artifact-store.js';
import { FakeStepRepository } from '../../../test-doubles/fake-step-repository.js';
import { FakeGitPort } from '../../../test-doubles/fake-git-port.js';
import { FakeValidationPort } from '../../../test-doubles/fake-validation-port.js';
import type { PhaseHandlerContext } from '../../handler.js';
import type { RunWorkspaceTypecheckInput } from '../../../ports/run-workspace-typecheck-port.js';

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

describe('ImplementHandler Declared Files Retry State Machine', () => {
  it('retries once with missing-file feedback and cumulative coverage from the original baseline', async () => {
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
    git.changedFilesResults.set('pre-step|attempt-1', ['src/a.ts']);
    git.changedFilesResults.set('pre-step|attempt-2', ['src/a.ts', 'src/b.ts']);

    const contexts: StepRunContext[] = [];
    const runStep = vi.fn(async (sctx: StepRunContext): Promise<StepRunResult> => {
      contexts.push(sctx);
      git.headByCwd.set(ctx.cwd, contexts.length === 1 ? 'attempt-1' : 'attempt-2');
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 1,
    }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(contexts[0]?.priorAttemptMissingFiles).toBeUndefined();
    expect(contexts[1]?.priorAttemptMissingFiles).toEqual(['src/b.ts']);
    expect(git.changedFilesCalls).toEqual([
      { cwd: ctx.cwd, base: 'pre-step', head: 'attempt-1' },
      { cwd: ctx.cwd, base: 'pre-step', head: 'attempt-2' },
    ]);
    expect(events.filter((e) => e.type === 'step.declared_files_retry')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'step.completed')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'step.uncommitted_files')).toHaveLength(0);
  });

  it('fails only after the declared-files retry budget is exhausted', async () => {
    const artifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    const manifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1: retry persistent failure',
          expected_files: ['src/a.ts', 'src/b.ts'],
        },
      ],
    };
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: retry persistent failure']),
    });
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'task-manifest.json',
      contents: JSON.stringify(manifest),
    });

    const steps = new FakeStepRepository();
    const { ctx, events } = makeCtx(artifacts, git);

    git.headByCwd.set(ctx.cwd, 'pre-step');
    git.changedFilesResults.set('pre-step|post-step-1', ['src/a.ts']);
    git.changedFilesResults.set('pre-step|post-step-2', ['src/a.ts']);
    git.changedFilesResults.set('pre-step|post-step-3', ['src/a.ts']);

    let attempts = 0;
    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      attempts++;
      git.headByCwd.set(ctx.cwd, `post-step-${attempts}`);
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 2,
    }).run(ctx);

    expect(result.outcome).toBe('failed');
    expect(runStep).toHaveBeenCalledTimes(3);
    expect(events.filter((e) => e.type === 'step.declared_files_retry')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'step.uncommitted_files')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'step.failed')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'step.completed')).toHaveLength(0);
  });

  it('maxDeclaredFilesRetries zero preserves immediate terminal failure', async () => {
    const artifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    const manifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1: no retries',
          expected_files: ['src/a.ts', 'src/b.ts'],
        },
      ],
    };
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: no retries']),
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

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 0,
    }).run(ctx);

    expect(result.outcome).toBe('failed');
    expect(runStep).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === 'step.declared_files_retry')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'step.uncommitted_files')).toHaveLength(1);
  });

  it('verified-unaffected files bypass the declared-files retry', async () => {
    const artifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    const validationPort = new FakeValidationPort();
    const manifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1: validation passes but files missing',
          expected_files: ['src/a.ts', 'src/b.ts'],
          validation_commands: ['pnpm vitest run src/test.spec.ts'],
        },
      ],
    };
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: validation passes but files missing']),
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

    validationPort.result = [
      {
        command: 'pnpm vitest run src/test.spec.ts',
        exitCode: 0,
        durationMs: 100,
        stdout: '',
        stderr: '',
        stdoutPath: '/tmp/validate/stdout',
        stderrPath: '/tmp/validate/stderr',
        outcome: 'passed',
      },
    ];

    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      git.headByCwd.set(ctx.cwd, 'post-step');
      return { outcome: 'success' };
    });

    const runWorkspaceTypecheck = vi.fn(async ({}: RunWorkspaceTypecheckInput) => ({ ok: true }));

    const result = await new ImplementHandler({
      steps,
      runStep,
      validationPort,
      runWorkspaceTypecheck,
      maxDeclaredFilesRetries: 1,
    }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(runStep).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === 'step.declared_files_retry')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'step.unaffected_files_verified')).toHaveLength(1);
  });

  it('a failed retry attempt follows the existing agent-incomplete path without another coverage retry', async () => {
    const artifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    const manifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1: retry then fail',
          expected_files: ['src/a.ts', 'src/b.ts'],
        },
      ],
    };
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: retry then fail']),
    });
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'task-manifest.json',
      contents: JSON.stringify(manifest),
    });

    const steps = new FakeStepRepository();
    const { ctx, events } = makeCtx(artifacts, git);

    git.headByCwd.set(ctx.cwd, 'pre-step');
    git.changedFilesResults.set('pre-step|post-step-1', ['src/a.ts']);
    git.changedFilesResults.set('pre-step|post-step-2', ['src/a.ts']);

    let attempts = 0;
    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      attempts++;
      git.headByCwd.set(ctx.cwd, `post-step-${attempts}`);
      if (attempts === 1) {
        return { outcome: 'success' };
      }
      return { outcome: 'failed' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 1,
    }).run(ctx);

    expect(result.outcome).toBe('failed');
    expect(runStep).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.type === 'step.declared_files_retry')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'step.failed')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'step.uncommitted_files')).toHaveLength(0);
  });
});
