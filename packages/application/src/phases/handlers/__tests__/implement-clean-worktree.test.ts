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

describe('ImplementHandler phase-boundary clean worktree', () => {
  it('returns passed and leaves clean worktree when all steps succeed with no extra changes', async () => {
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
    git.statusByCwd.set('/tmp/wt', ''); // clean
    const runStep = vi
      .fn<(sctx: StepRunContext) => Promise<StepRunResult>>()
      .mockImplementation(async () => {
        return { outcome: 'success' };
      });
    const { ctx } = makeCtx(artifacts, git);

    const result = await new ImplementHandler({ steps, runStep }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(git.commits).toHaveLength(0); // no phase-boundary commits needed since worktree is clean
  });

  it('fails with needs_human_review when uncommitted substantive (non-formatting) files exist at phase boundary', async () => {
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
    // Uncommitted: substantive change to a new file (not formatting, not exempt)
    git.statusByCwd.set(
      '/tmp/wt',
      '?? packages/infrastructure/src/postgres/test-support/postgres-18.ts\n',
    );
    const runStep = vi
      .fn<(sctx: StepRunContext) => Promise<StepRunResult>>()
      .mockImplementation(async () => {
        return { outcome: 'success' };
      });
    const { ctx } = makeCtx(artifacts, git);

    const result = await new ImplementHandler({ steps, runStep }).run(ctx);

    expect(result.outcome).toBe('needs_human_review');
    if (result.outcome === 'needs_human_review') {
      expect(result.failure.message).toContain('postgres-18.ts');
    }
  });

  it('auto-commits formatting-only changes at phase boundary and returns passed', async () => {
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
    // Uncommitted: formatting-only change (whitespace change that parses the same)
    git.statusByCwd.set('/tmp/wt', ' M apps/control-api/src/app.ts\n');
    git.fileContentResults.set('HEAD:apps/control-api/src/app.ts', 'const x = 1;\n');
    const worktreeFiles = new Map<string, string>();
    worktreeFiles.set('apps/control-api/src/app.ts', 'const x = 1; \n');
    const runStep = vi
      .fn<(sctx: StepRunContext) => Promise<StepRunResult>>()
      .mockImplementation(async () => {
        return { outcome: 'success' };
      });
    const { ctx } = makeCtx(artifacts, git, worktreeFiles);

    const result = await new ImplementHandler({ steps, runStep }).run(ctx);

    // The formatting-only change should be auto-committed and the phase passes
    expect(result.outcome).toBe('passed');
    expect(git.commits.some((c) => c.message.includes('auto-commit formatting debt'))).toBe(true);
  });

  it('auto-commits exempt files at phase boundary and returns passed', async () => {
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
    // Uncommitted: exempt file (pnpm-lock.yaml is globally exempt)
    git.statusByCwd.set('/tmp/wt', '?? pnpm-lock.yaml\n');
    const runStep = vi
      .fn<(sctx: StepRunContext) => Promise<StepRunResult>>()
      .mockImplementation(async () => {
        return { outcome: 'success' };
      });
    const { ctx } = makeCtx(artifacts, git);

    const result = await new ImplementHandler({
      steps,
      runStep,
      exemptUndeclaredFiles: ['pnpm-lock.yaml'],
    }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(git.commits.some((c) => c.message.includes('auto-commit formatting debt'))).toBe(true);
  });

  it('fails with needs_human_review when protected file is modified', async () => {
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
    // Uncommitted: protected file modification
    git.statusByCwd.set('/tmp/wt', ' M .gitignore\n');
    const runStep = vi
      .fn<(sctx: StepRunContext) => Promise<StepRunResult>>()
      .mockImplementation(async () => {
        return { outcome: 'success' };
      });
    const { ctx } = makeCtx(artifacts, git);

    const result = await new ImplementHandler({ steps, runStep }).run(ctx);

    expect(result.outcome).toBe('needs_human_review');
    if (result.outcome === 'needs_human_review') {
      expect(result.failure.message).toContain('.gitignore');
    }
  });
});
