import { describe, it, expect, vi } from 'vitest';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { ImplementHandler } from '../implement.js';
import type { StepRunResult } from '../implement.js';
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

async function writePlanAndManifest(
  artifacts: FakeArtifactStore,
  manifest: {
    version: number;
    task_count: number;
    tasks: Array<{
      n: number;
      title: string;
      expected_files?: string[];
      files?: string[];
    }>;
  },
  runUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
): Promise<void> {
  await artifacts.write({
    runId: runUuid,
    relativePath: 'plan.md',
    contents: planMd(manifest.tasks.map((t) => t.title)),
  });
  await artifacts.write({
    runId: runUuid,
    relativePath: 'task-manifest.json',
    contents: JSON.stringify(manifest),
  });
}

describe('ImplementHandler undeclared files regression proof', () => {
  it('retries a successful step that commits an unrelated undeclared file', async () => {
    const artifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    const steps = new FakeStepRepository();
    const { ctx, events } = makeCtx(artifacts, git);

    await writePlanAndManifest(artifacts, {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1: change only the declared file',
          expected_files: ['src/declared.ts'],
        },
      ],
    });

    git.headByCwd.set(ctx.cwd, 'pre-step');
    git.changedFilesResults.set('pre-step|attempt-1', ['src/declared.ts', 'src/future-task.ts']);
    git.changedFilesResults.set('pre-step|attempt-2', ['src/declared.ts']);

    let attempt = 0;
    const runStep = vi.fn(async (): Promise<StepRunResult> => {
      attempt += 1;
      git.headByCwd.set(ctx.cwd, `attempt-${attempt}`);
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 1,
    }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(runStep).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event.type === 'step.declared_files_retry')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'step.completed')).toHaveLength(1);
  });
});
