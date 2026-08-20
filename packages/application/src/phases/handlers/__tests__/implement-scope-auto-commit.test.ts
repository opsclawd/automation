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
}

async function setupHarness(options: SetupOptions = {}) {
  const taskTitle = options.taskTitle ?? 'Task 1: do something';
  const expectedFiles = options.expectedFiles ?? ['src/feature.ts'];
  const mayExtend = options.mayExtend;
  const permittedAreas = options.permittedAreas;
  const artifacts = new FakeArtifactStore();
  const git = new FakeGitPort();

  const manifest = {
    version: 2,
    task_count: 1,
    tasks: [
      {
        n: 1,
        title: taskTitle,
        expected_files: expectedFiles,
        ...(mayExtend !== undefined ? { may_extend: mayExtend } : {}),
        ...(permittedAreas !== undefined ? { permitted_areas: permittedAreas } : {}),
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
    steps,
    ctx,
    events,
    taskTitle,
    expectedFiles,
    mayExtend,
    permittedAreas,
  };
}

describe('ImplementHandler Scope-Aware Auto-Commit', () => {
  it('auto-commits a dirty may_extend file with the required deliverable', async () => {
    const { git, steps, ctx, events, taskTitle } = await setupHarness({
      expectedFiles: ['src/feature.ts'],
      mayExtend: ['src/client.ts'],
    });

    git.status = vi.fn(async () => {
      const committed =
        git.commits.some((c) => c.files?.includes('src/feature.ts')) &&
        git.commits.some((c) => c.files?.includes('src/client.ts'));
      return committed ? '' : ' M src/feature.ts\n M src/client.ts';
    });
    git.changedFilesResults.set('pre-step|pre-step', []);
    git.changedFilesResults.set('pre-step|fake-sha-1', ['src/client.ts', 'src/feature.ts']);

    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 1,
    }).run(ctx);

    expect(git.addCalls).toEqual([{ cwd: '/tmp/wt', files: ['src/client.ts', 'src/feature.ts'] }]);
    expect(git.commits[0]).toEqual({
      cwd: '/tmp/wt',
      message: taskTitle,
      sha: 'fake-sha-1',
      files: ['src/client.ts', 'src/feature.ts'],
    });
    expect(runStep).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === 'step.declared_files_retry')).toHaveLength(0);
    expect(result.outcome).toBe('passed');
  });

  it('does not auto-commit an untracked file authorized only by permitted_areas', async () => {
    const { git, steps, ctx } = await setupHarness({
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
      maxDeclaredFilesRetries: 1,
    }).run(ctx);

    for (const call of git.addCalls) {
      expect(call.files).not.toContain('src/untracked.ts');
    }
    for (const commit of git.commits) {
      expect(commit.files).not.toContain('src/untracked.ts');
    }
    expect(result.outcome).toBe('needs_human_review');
  });
});
