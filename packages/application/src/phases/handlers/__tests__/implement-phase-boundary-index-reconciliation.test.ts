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

describe('ImplementHandler phase-boundary index reconciliation', () => {
  it('auto-commits staged formatting when the worktree matches HEAD', async () => {
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

    const path = 'apps/api/src/compose.ts';
    const head = 'const value = call(one, two);\n';
    const staged = 'const value = call(\n  one,\n  two,\n);\n';

    git.fileContentResults.set(`HEAD:${path}`, head);
    git.fileContentResults.set(`:0:${path}`, staged);
    const worktreeFiles = new Map<string, string>();
    worktreeFiles.set(path, head);

    const statusOutputs = [
      '', // step scratch-file / baseline check
      `MM ${path}\n`, // phase-boundary snapshot
      `MM ${path}\n`, // action-time recheck
      `M  ${path}\n`, // staged status check before commit
      '', // clean final status
    ];
    git.status = vi.fn(async () => statusOutputs.shift() ?? '');

    const origCheckout = git.checkout.bind(git);
    const checkoutSpy = vi.fn(async (cwd: string, ref: string, files: string[]) => {
      return origCheckout(cwd, ref, files);
    });
    git.checkout = checkoutSpy;

    const runStep = vi
      .fn<(sctx: StepRunContext) => Promise<StepRunResult>>()
      .mockImplementation(async (sctx) => {
        sctx.ctx.git.headByCwd.set(sctx.cwd, 'step-1');
        return { outcome: 'success' };
      });
    const { ctx, events } = makeCtx(artifacts, git, worktreeFiles);

    const result = await new ImplementHandler({ steps, runStep }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(git.fileContentCalls).toContainEqual({ cwd: '/tmp/wt', ref: ':0', path });
    expect(git.addCalls.some((c) => c.files.includes(path))).toBe(false);
    expect(
      git.commits.some((c) =>
        c.message.includes(
          'auto-commit formatting debt and exempt files at implement phase boundary',
        ),
      ),
    ).toBe(true);
    expect(checkoutSpy).toHaveBeenCalledWith('/tmp/wt', 'HEAD', [path]);
    expect(
      events.some(
        (e) =>
          e.type === 'implement.formatting_debt_auto_committed' &&
          (e.metadata as { files?: string[] })?.files?.includes(path),
      ),
    ).toBe(true);
  });

  it('commits staged formatting without reset when index and worktree agree', async () => {
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

    const path = 'apps/api/src/compose.ts';
    const head = 'const value = call(one, two);\n';
    const formatted = 'const value = call(\n  one,\n  two,\n);\n';

    git.fileContentResults.set(`HEAD:${path}`, head);
    git.fileContentResults.set(`:0:${path}`, formatted);
    const worktreeFiles = new Map<string, string>();
    worktreeFiles.set(path, formatted);

    const statusOutputs = [
      '', // step scratch-file / baseline check
      `M  ${path}\n`, // phase-boundary snapshot
      `M  ${path}\n`, // action-time recheck
      `M  ${path}\n`, // staged status check
      '', // clean final status
    ];
    git.status = vi.fn(async () => statusOutputs.shift() ?? '');

    const origCheckout = git.checkout.bind(git);
    const checkoutSpy = vi.fn(async (cwd: string, ref: string, files: string[]) => {
      return origCheckout(cwd, ref, files);
    });
    git.checkout = checkoutSpy;

    const runStep = vi
      .fn<(sctx: StepRunContext) => Promise<StepRunResult>>()
      .mockImplementation(async (sctx) => {
        sctx.ctx.git.headByCwd.set(sctx.cwd, 'step-1');
        return { outcome: 'success' };
      });
    const { ctx } = makeCtx(artifacts, git, worktreeFiles);

    const result = await new ImplementHandler({ steps, runStep }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(git.addCalls.some((c) => c.files.includes(path))).toBe(false);
    expect(
      git.commits.some((c) =>
        c.message.includes(
          'auto-commit formatting debt and exempt files at implement phase boundary',
        ),
      ),
    ).toBe(true);
    expect(checkoutSpy).not.toHaveBeenCalled();
  });

  it('stages unstaged formatting when index still equals HEAD', async () => {
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

    const path = 'apps/api/src/compose.ts';
    const head = 'const value = call(one, two);\n';
    const formatted = 'const value = call(\n  one,\n  two,\n);\n';

    git.fileContentResults.set(`HEAD:${path}`, head);
    git.fileContentResults.set(`:0:${path}`, head);
    const worktreeFiles = new Map<string, string>();
    worktreeFiles.set(path, formatted);

    const statusOutputs = [
      '', // step scratch-file / baseline check
      ` M ${path}\n`, // phase-boundary snapshot
      ` M ${path}\n`, // action-time recheck
      `M  ${path}\n`, // staged status check after add
      '', // clean final status
    ];
    git.status = vi.fn(async () => statusOutputs.shift() ?? '');

    const origCheckout = git.checkout.bind(git);
    const checkoutSpy = vi.fn(async (cwd: string, ref: string, files: string[]) => {
      return origCheckout(cwd, ref, files);
    });
    git.checkout = checkoutSpy;

    const runStep = vi
      .fn<(sctx: StepRunContext) => Promise<StepRunResult>>()
      .mockImplementation(async (sctx) => {
        sctx.ctx.git.headByCwd.set(sctx.cwd, 'step-1');
        return { outcome: 'success' };
      });
    const { ctx } = makeCtx(artifacts, git, worktreeFiles);

    const result = await new ImplementHandler({ steps, runStep }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(git.addCalls).toContainEqual({ cwd: '/tmp/wt', files: [path] });
    expect(
      git.commits.some((c) =>
        c.message.includes(
          'auto-commit formatting debt and exempt files at implement phase boundary',
        ),
      ),
    ).toBe(true);
    expect(checkoutSpy).not.toHaveBeenCalled();
  });

  it('falls back to worktree formatting when the index entry is missing', async () => {
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

    const path = 'apps/api/src/compose.ts';
    const head = 'const value = call(one, two);\n';
    const formatted = 'const value = call(\n  one,\n  two,\n);\n';

    git.fileContentResults.set(`HEAD:${path}`, head);
    const worktreeFiles = new Map<string, string>();
    worktreeFiles.set(path, formatted);

    const origFileContent = git.fileContent.bind(git);
    git.fileContent = vi.fn(async (cwd: string, ref: string, p: string) => {
      if (ref === ':0') {
        throw new Error(`fatal: path '${p}' does not exist in the index`);
      }
      return origFileContent(cwd, ref, p);
    });

    const statusOutputs = [
      '', // step scratch-file / baseline check
      ` M ${path}\n`, // phase-boundary snapshot
      ` M ${path}\n`, // action-time recheck
      `M  ${path}\n`, // staged status check after add
      '', // clean final status
    ];
    git.status = vi.fn(async () => statusOutputs.shift() ?? '');

    const runStep = vi
      .fn<(sctx: StepRunContext) => Promise<StepRunResult>>()
      .mockImplementation(async (sctx) => {
        sctx.ctx.git.headByCwd.set(sctx.cwd, 'step-1');
        return { outcome: 'success' };
      });
    const { ctx } = makeCtx(artifacts, git, worktreeFiles);

    const result = await new ImplementHandler({ steps, runStep }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(git.addCalls).toContainEqual({ cwd: '/tmp/wt', files: [path] });
    expect(
      git.commits.some((c) =>
        c.message.includes(
          'auto-commit formatting debt and exempt files at implement phase boundary',
        ),
      ),
    ).toBe(true);
  });

  it('escalates staged substantive content when the worktree matches HEAD', async () => {
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

    const path = 'apps/api/src/compose.ts';
    const head = 'const value = 1;\n';
    const stagedSubstantive = 'const value = 2;\n';

    git.fileContentResults.set(`HEAD:${path}`, head);
    git.fileContentResults.set(`:0:${path}`, stagedSubstantive);
    const worktreeFiles = new Map<string, string>();
    worktreeFiles.set(path, head);

    const statusOutputs = [
      '', // step scratch-file / baseline check
      `MM ${path}\n`, // phase-boundary snapshot
    ];
    git.status = vi.fn(async () => statusOutputs.shift() ?? '');

    const origCheckout = git.checkout.bind(git);
    const checkoutSpy = vi.fn(async (cwd: string, ref: string, files: string[]) => {
      return origCheckout(cwd, ref, files);
    });
    git.checkout = checkoutSpy;

    const runStep = vi
      .fn<(sctx: StepRunContext) => Promise<StepRunResult>>()
      .mockImplementation(async (sctx) => {
        sctx.ctx.git.headByCwd.set(sctx.cwd, 'step-1');
        return { outcome: 'success' };
      });
    const { ctx } = makeCtx(artifacts, git, worktreeFiles);

    const result = await new ImplementHandler({ steps, runStep }).run(ctx);

    expect(result.outcome).toBe('needs_human_review');
    expect(git.commits).toHaveLength(0);
    expect(git.addCalls.some((c) => c.files.includes(path))).toBe(false);
    expect(checkoutSpy).not.toHaveBeenCalled();
    if (result.outcome === 'needs_human_review') {
      expect(result.failure.message).toContain(path);
    }
  });

  it('escalates ambiguous mixed content instead of resetting it away', async () => {
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

    const path = 'apps/api/src/compose.ts';
    const head = 'const value = 1;\n';
    const stagedSubstantive = 'const value = 2;\n';
    const worktreeFormatting = 'const value = 1; \n';

    git.fileContentResults.set(`HEAD:${path}`, head);
    git.fileContentResults.set(`:0:${path}`, stagedSubstantive);
    const worktreeFiles = new Map<string, string>();
    worktreeFiles.set(path, worktreeFormatting);

    const statusOutputs = [
      '', // step scratch-file / baseline check
      `MM ${path}\n`, // phase-boundary snapshot
    ];
    git.status = vi.fn(async () => statusOutputs.shift() ?? '');

    const origCheckout = git.checkout.bind(git);
    const checkoutSpy = vi.fn(async (cwd: string, ref: string, files: string[]) => {
      return origCheckout(cwd, ref, files);
    });
    git.checkout = checkoutSpy;

    const runStep = vi
      .fn<(sctx: StepRunContext) => Promise<StepRunResult>>()
      .mockImplementation(async (sctx) => {
        sctx.ctx.git.headByCwd.set(sctx.cwd, 'step-1');
        return { outcome: 'success' };
      });
    const { ctx } = makeCtx(artifacts, git, worktreeFiles);

    const result = await new ImplementHandler({ steps, runStep }).run(ctx);

    expect(result.outcome).toBe('needs_human_review');
    expect(git.commits).toHaveLength(0);
    expect(git.addCalls.some((c) => c.files.includes(path))).toBe(false);
    expect(checkoutSpy).not.toHaveBeenCalled();
    if (result.outcome === 'needs_human_review') {
      expect(result.failure.message).toContain(path);
    }
  });

  it('fails when post-commit checkout cannot synchronize the worktree', async () => {
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

    const path = 'apps/api/src/compose.ts';
    const head = 'const value = call(one, two);\n';
    const staged = 'const value = call(\n  one,\n  two,\n);\n';

    git.fileContentResults.set(`HEAD:${path}`, head);
    git.fileContentResults.set(`:0:${path}`, staged);
    const worktreeFiles = new Map<string, string>();
    worktreeFiles.set(path, head);

    const statusOutputs = [
      '', // step scratch-file / baseline check
      `MM ${path}\n`, // phase-boundary snapshot
      `MM ${path}\n`, // action-time recheck
      `M  ${path}\n`, // staged status check before commit
      '',
    ];
    git.status = vi.fn(async () => statusOutputs.shift() ?? '');

    const checkoutSpy = vi.fn(async (cwd: string, ref: string, _files: string[]) => {
      if (ref === 'HEAD') {
        throw new Error('checkout failed due to lock');
      }
    });
    git.checkout = checkoutSpy;

    const origResetHard = git.resetHard.bind(git);
    const resetHardSpy = vi.fn(async (cwd: string, ref: string) => {
      return origResetHard(cwd, ref);
    });
    git.resetHard = resetHardSpy;

    const runStep = vi
      .fn<(sctx: StepRunContext) => Promise<StepRunResult>>()
      .mockImplementation(async (sctx) => {
        sctx.ctx.git.headByCwd.set(sctx.cwd, 'step-1');
        return { outcome: 'success' };
      });
    const { ctx } = makeCtx(artifacts, git, worktreeFiles);

    const result = await new ImplementHandler({ steps, runStep }).run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.message).toContain('phase-boundary auto-commit failed');
    }
    expect(checkoutSpy).toHaveBeenCalledWith('/tmp/wt', 'HEAD', [path]);
    expect(resetHardSpy).toHaveBeenCalledWith('/tmp/wt', 'step-1');
  });

  it('fails instead of passing when source paths remain dirty after reconciliation', async () => {
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

    const path = 'apps/api/src/compose.ts';
    const head = 'const value = call(one, two);\n';
    const staged = 'const value = call(\n  one,\n  two,\n);\n';

    git.fileContentResults.set(`HEAD:${path}`, head);
    git.fileContentResults.set(`:0:${path}`, staged);
    const worktreeFiles = new Map<string, string>();
    worktreeFiles.set(path, head);

    const statusOutputs = [
      '', // step scratch-file / baseline check
      `MM ${path}\n`, // phase-boundary snapshot
      `MM ${path}\n`, // action-time recheck
      `M  ${path}\n`, // staged status check before commit
      '?? residual-dirty.ts\n', // dirty final status!
    ];
    git.status = vi.fn(async () => statusOutputs.shift() ?? '');

    const runStep = vi
      .fn<(sctx: StepRunContext) => Promise<StepRunResult>>()
      .mockImplementation(async (sctx) => {
        sctx.ctx.git.headByCwd.set(sctx.cwd, 'step-1');
        return { outcome: 'success' };
      });
    const { ctx, events } = makeCtx(artifacts, git, worktreeFiles);

    const result = await new ImplementHandler({ steps, runStep }).run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.message).toMatch(/phase-boundary reconciliation|residual-dirty\.ts/);
    }
    expect(events.some((e) => e.type === 'implement.completed')).toBe(false);
  });

  it('fails instead of passing when hasStaged evaluates to false but dirty source paths remain', async () => {
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

    const path = 'apps/api/src/compose.ts';
    const head = 'const value = call(one, two);\n';
    const formatted = 'const value = call(\n  one,\n  two,\n);\n';

    git.fileContentResults.set(`HEAD:${path}`, head);
    git.fileContentResults.set(`:0:${path}`, head);
    const worktreeFiles = new Map<string, string>();
    worktreeFiles.set(path, formatted);

    const statusOutputs = [
      '', // step scratch-file / baseline check
      ` M ${path}\n`, // phase-boundary snapshot
      ` M ${path}\n`, // action-time recheck
      ` M ${path}\n`, // statusAfterAdd returns unchanged (hasStaged = false)
      ` M ${path}\n`, // final status check shows still dirty
    ];
    git.status = vi.fn(async () => statusOutputs.shift() ?? '');

    const runStep = vi
      .fn<(sctx: StepRunContext) => Promise<StepRunResult>>()
      .mockImplementation(async (sctx) => {
        sctx.ctx.git.headByCwd.set(sctx.cwd, 'step-1');
        return { outcome: 'success' };
      });
    const { ctx, events } = makeCtx(artifacts, git, worktreeFiles);

    const result = await new ImplementHandler({ steps, runStep }).run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.message).toContain(
        'phase-boundary reconciliation left uncommitted source paths',
      );
    }
    expect(events.some((e) => e.type === 'implement.completed')).toBe(false);
  });
});
