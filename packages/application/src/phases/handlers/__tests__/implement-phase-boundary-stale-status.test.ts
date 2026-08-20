import { describe, it, expect, vi } from 'vitest';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { ImplementHandler } from '../implement.js';
import type { StepRunContext, StepRunResult } from '../implement.js';
import { FakeArtifactStore } from '../../../test-doubles/fake-artifact-store.js';
import { FakeStepRepository } from '../../../test-doubles/fake-step-repository.js';
import { FakeGitPort } from '../../../test-doubles/fake-git-port.js';
import type { PhaseHandlerContext } from '../../handler.js';

function makeCtx(
  artifacts: FakeArtifactStore,
  git = new FakeGitPort(),
  worktreeFiles = new Map<string, string>(),
) {
  const events: OrchestratorEvent[] = [];
  const now = () => new Date('2026-06-16T00:00:00Z');
  const readWorktreeFile = vi.fn(async (_cwd: string, relativePath: string) => {
    return worktreeFiles.get(relativePath);
  });
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
    readWorktreeFile,
  } satisfies PhaseHandlerContext;
  return { ctx, events, readWorktreeFile };
}

function planMd(tasks: string[]): string {
  return ['# Plan', '', ...tasks.map((t) => `## ${t}`), '', '## Notes', 'Extra.'].join('\n');
}

describe('ImplementHandler phase-boundary stale status recovery (issue #960)', () => {
  it('does not auto-commit files that were committed between status snapshot and add', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: work']),
    });
    const steps = new FakeStepRepository();
    const git = new FakeGitPort();
    git.headByCwd.set('/tmp/wt', 'head-sha');
    git.changedFilesResults.set('head-sha|step-1', ['src/util.ts']);

    const statusOutputs = [
      '', // initial scratch-file check
      '?? pnpm-lock.yaml\n', // phase-boundary snapshot
      '', // re-check before add/commit (after our fix)
    ];
    git.status = vi.fn(async (_cwd: string) => {
      const next = statusOutputs.shift();
      if (next === undefined) {
        return '';
      }
      return next;
    });

    const runStep = vi
      .fn<(sctx: StepRunContext) => Promise<StepRunResult>>()
      .mockImplementation(async (sctx) => {
        sctx.ctx.git.headByCwd.set(sctx.cwd, 'step-1');
        return { outcome: 'success' };
      });
    const { ctx } = makeCtx(artifacts, git);

    const result = await new ImplementHandler({
      steps,
      runStep,
      exemptUndeclaredFiles: ['pnpm-lock.yaml'],
    }).run(ctx);

    expect(result.outcome).toBe('passed');
    const exemptAutoCommit = git.commits.find((c) =>
      c.message.includes('auto-commit formatting debt'),
    );
    expect(exemptAutoCommit).toBeUndefined();
    expect(git.addCalls).toEqual([]);
  });

  it('auto-commits only files still dirty at the moment of action', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: work']),
    });
    const steps = new FakeStepRepository();
    const git = new FakeGitPort();
    git.headByCwd.set('/tmp/wt', 'head-sha');
    git.changedFilesResults.set('head-sha|step-1', ['src/util.ts']);
    git.fileContentResults.set('HEAD:apps/control-api/src/app.ts', 'const x = 1;\n');
    git.fileContentResults.set('head-sha:apps/control-api/src/app.ts', 'const x = 1;\n');
    git.fileContentResults.set('step-1:apps/control-api/src/app.ts', 'const x = 1;\n');

    const statusOutputs = [
      ' M apps/control-api/src/app.ts\n?? pnpm-lock.yaml\n',
      ' M apps/control-api/src/app.ts\n?? pnpm-lock.yaml\n',
      ' M apps/control-api/src/app.ts\n',
    ];
    git.status = vi.fn(async (_cwd: string) => {
      const next = statusOutputs.shift();
      if (next === undefined) {
        return '';
      }
      return next;
    });

    const worktreeFiles = new Map<string, string>();
    worktreeFiles.set('apps/control-api/src/app.ts', 'const x = 1; \n');
    const runStep = vi
      .fn<(sctx: StepRunContext) => Promise<StepRunResult>>()
      .mockImplementation(async (sctx) => {
        sctx.ctx.git.headByCwd.set(sctx.cwd, 'step-1');
        return { outcome: 'success' };
      });
    const { ctx } = makeCtx(artifacts, git, worktreeFiles);

    const result = await new ImplementHandler({
      steps,
      runStep,
      exemptUndeclaredFiles: ['pnpm-lock.yaml'],
    }).run(ctx);

    expect(result.outcome).toBe('passed');
    const autoCommit = git.commits.find((c) => c.message.includes('auto-commit formatting debt'));
    expect(autoCommit).toBeDefined();
    expect(autoCommit?.files).toEqual(['apps/control-api/src/app.ts']);
  });
});
