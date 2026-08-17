import { describe, it, expect, vi } from 'vitest';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import type { RunId } from '@ai-sdlc/domain';
import { ImplementHandler } from '../implement.js';
import type { StepRunContext, StepRunResult } from '../implement.js';
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

describe('ImplementHandler inherited formatting debt regression proof', () => {
  it("allows task B to commit formatter-only changes to task A's completed declared TypeScript file", async () => {
    const artifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    const steps = new FakeStepRepository();
    const { ctx, events } = makeCtx(artifacts, git);

    const manifest = {
      version: 2,
      task_count: 2,
      tasks: [
        { n: 1, title: 'Write task A', expected_files: ['src/a.ts'] },
        {
          n: 2,
          title: 'Write task B after the repo formatter',
          expected_files: ['src/b.ts'],
          reference_files: ['src/a.ts'],
          validation_commands: ['pnpm format'],
        },
      ],
    };

    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents: planMd(['Task 1: Write task A', 'Task 2: Write task B after the repo formatter']),
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'task-manifest.json',
      contents: JSON.stringify(manifest),
    });

    git.headByCwd.set(ctx.cwd, 'base');
    git.changedFilesResults.set('base|task-a', ['src/a.ts']);
    git.changedFilesResults.set('task-a|task-b', ['src/a.ts', 'src/b.ts']);
    git.fileContentResults.set('task-a:src/a.ts', 'export const value={answer:42}\n');
    git.fileContentResults.set('task-b:src/a.ts', 'export const value = { answer: 42 };\n');

    const runStep = vi.fn(async (sctx: StepRunContext): Promise<StepRunResult> => {
      if (sctx.stepIndex === 1) {
        git.headByCwd.set(ctx.cwd, 'task-a');
      } else if (sctx.stepIndex === 2) {
        git.headByCwd.set(ctx.cwd, 'task-b');
      }
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 0,
    }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(
      steps.listForRun(ctx.runUuid as RunId).map(({ index, status }) => ({ index, status })),
    ).toEqual([
      { index: 1, status: 'success' },
      { index: 2, status: 'success' },
    ]);
    expect(events.filter((event) => event.type === 'step.declared_files_retry')).toHaveLength(0);
    expect(
      events.find((event) => event.type === 'step.inherited_formatting_debt')?.metadata,
    ).toMatchObject({ index: 2, files: ['src/a.ts'] });
  });
});
