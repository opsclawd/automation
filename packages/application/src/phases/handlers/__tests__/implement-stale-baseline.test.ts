import { describe, it, expect, vi } from 'vitest';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { ImplementHandler } from '../implement.js';
import type { StepRunContext, StepRunResult } from '../implement.js';
import { RunId, PhaseName } from '@ai-sdlc/domain';
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

describe('ImplementHandler stale baseline recovery (issue #960)', () => {
  it('refreshes a stale initialPreStepHead when prior step was amended out of ancestry', async () => {
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
          title: 'Task 2: resume after step 1 amend',
          expected_files: ['src/step2.ts'],
        },
      ],
    };
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: already done', 'Task 2: resume after step 1 amend']),
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
    steps.upsert({
      id: 'step-2',
      runId: RunId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
      phaseId: 'implement',
      index: 2,
      title: 'Task 2: resume after step 1 amend',
      status: 'failed',
      initialPreStepHead: 'step-1-original-sha',
      startedAt: new Date(),
      completedAt: new Date(),
    });

    const { ctx, events } = makeCtx(artifacts, git);

    git.headByCwd.set(ctx.cwd, 'step-1-amended-sha');
    git.ancestorResults.set('step-1-original-sha|step-1-amended-sha', false);
    git.changedFilesResults.set('step-1-original-sha|post-step-2', [
      'fix-commit-verifier.test.ts',
      'src/step2.ts',
    ]);
    git.changedFilesResults.set('step-1-amended-sha|post-step-2', ['src/step2.ts']);

    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      git.headByCwd.set(ctx.cwd, 'post-step-2');
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({ steps, runStep }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(git.changedFilesCalls).toEqual([
      { cwd: '/tmp/wt', base: 'step-1-amended-sha', head: 'post-step-2' },
    ]);
    expect(
      steps.findByIndex(RunId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), PhaseName('implement'), 2)
        ?.initialPreStepHead,
    ).toBe('step-1-amended-sha');

    const uncommitted = events.filter((e) => e.type === 'step.uncommitted_files');
    expect(uncommitted).toHaveLength(0);
  });

  it('keeps a valid initialPreStepHead when it is still an ancestor of HEAD', async () => {
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
          title: 'Task 2: resume',
          expected_files: ['src/step2.ts'],
        },
      ],
    };
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: already done', 'Task 2: resume']),
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
    steps.upsert({
      id: 'step-2',
      runId: RunId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
      phaseId: 'implement',
      index: 2,
      title: 'Task 2: resume',
      status: 'failed',
      initialPreStepHead: 'head-before-first-attempt',
      startedAt: new Date(),
      completedAt: new Date(),
    });

    const { ctx } = makeCtx(artifacts, git);

    git.headByCwd.set(ctx.cwd, 'head-after-prior-attempt');
    git.ancestorResults.set('head-before-first-attempt|head-after-prior-attempt', true);
    git.changedFilesResults.set('head-before-first-attempt|post-step-2', ['src/step2.ts']);

    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      git.headByCwd.set(ctx.cwd, 'post-step-2');
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({ steps, runStep }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(git.changedFilesCalls).toEqual([
      { cwd: '/tmp/wt', base: 'head-before-first-attempt', head: 'post-step-2' },
    ]);
    expect(
      steps.findByIndex(RunId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), PhaseName('implement'), 2)
        ?.initialPreStepHead,
    ).toBe('head-before-first-attempt');
  });
});
