import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { ImplementHandler } from '../implement.js';
import { ValidateHandler } from '../validate.js';
import type { StepRunResult } from '../implement.js';
import { FakeArtifactStore } from '../../../test-doubles/fake-artifact-store.js';
import { FakeGitPort } from '../../../test-doubles/fake-git-port.js';
import { FakeStepRepository } from '../../../test-doubles/fake-step-repository.js';
import { FakeValidationPort } from '../../../test-doubles/fake-validation-port.js';
import { FakeValidationRunRepository } from '../../../test-doubles/fake-validation-run-repository.js';
import { RunValidation } from '../../../run-validation.js';
import type { PhaseHandlerContext } from '../../handler.js';

const RUN_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

type TaskSurface = {
  expected_files: string[];
  reference_files?: string[];
};

async function makeHarness(task: TaskSurface, status: string) {
  const artifacts = new FakeArtifactStore();
  const git = new FakeGitPort();
  const steps = new FakeStepRepository();
  const events: OrchestratorEvent[] = [];
  const title = 'detect scratch files';

  await artifacts.write({
    runId: RUN_UUID,
    relativePath: 'plan.md',
    contents: `# Plan\n\n## Task 1: ${title}\n`,
  });
  await artifacts.write({
    runId: RUN_UUID,
    relativePath: 'task-manifest.json',
    contents: JSON.stringify({
      version: 2,
      task_count: 1,
      tasks: [{ n: 1, title, ...task }],
    }),
  });

  const ctx = {
    runId: 'run-1',
    runUuid: RUN_UUID,
    repoFullName: 'acme/widgets',
    issueNumber: 42,
    cwd: '/tmp/wt',
    artifacts,
    github: {} as PhaseHandlerContext['github'],
    git,
    agent: {} as PhaseHandlerContext['agent'],
    events: {
      publish: (_runUuid: string, event: OrchestratorEvent) => events.push(event),
      subscribe: () => () => {},
    },
    now: () => new Date('2026-08-16T18:00:00.000Z'),
    idFactory: () => 'step-1',
  } satisfies PhaseHandlerContext;

  git.headByCwd.set(ctx.cwd, 'pre-step');
  git.statusByCwd.set(ctx.cwd, status);

  const runStep = vi.fn(async (): Promise<StepRunResult> => {
    git.headByCwd.set(ctx.cwd, 'post-step');
    return { outcome: 'success' };
  });

  return { artifacts, ctx, events, git, runStep, steps };
}

describe('ImplementHandler scratch-file reporting', () => {
  it('warns with sorted undeclared files without failing or deleting the step output', async () => {
    const harness = await makeHarness(
      {
        expected_files: ['src/declared.ts'],
        reference_files: ['declared-reference.txt'],
      },
      [
        '?? z-scratch.txt',
        '?? "scratch file.ts"',
        '?? nested/not-root.ts',
        '?? declared-reference.txt',
        '?? allowed-root.txt',
      ].join('\n'),
    );
    harness.git.changedFilesResults.set('pre-step|post-step', ['src/declared.ts']);

    const result = await new ImplementHandler({
      steps: harness.steps,
      runStep: harness.runStep,
      exemptUndeclaredFiles: ['allowed-root.txt'],
    }).run(harness.ctx);

    expect(result).toMatchObject({ outcome: 'needs_human_review' });
    const warning = harness.events.find((event) => event.type === 'step.scratch_files_left');
    expect(warning).toMatchObject({
      level: 'warn',
      metadata: {
        index: 1,
        total: 1,
        taskTitle: 'detect scratch files',
        files: ['nested/not-root.ts', 'scratch file.ts', 'z-scratch.txt'],
      },
    });
    expect(warning?.message).toContain('nested/not-root.ts, scratch file.ts, z-scratch.txt');
    expect(harness.events.filter((event) => event.type === 'step.completed')).toHaveLength(1);
    expect(harness.events.filter((event) => event.type === 'step.failed')).toHaveLength(0);
    expect(
      harness.events.filter((event) => event.type === 'step.declared_files_retry'),
    ).toHaveLength(0);
    expect(harness.git.cleanUntrackedCalls).toEqual([]);
  });

  it('reads git status for a clean successful step and emits no scratch warning', async () => {
    const harness = await makeHarness({ expected_files: ['src/declared.ts'] }, '');
    harness.git.changedFilesResults.set('pre-step|post-step', ['src/declared.ts']);

    const result = await new ImplementHandler({
      steps: harness.steps,
      runStep: harness.runStep,
    }).run(harness.ctx);

    expect(result).toEqual({ outcome: 'passed' });
    expect(harness.git.statusCalls).toEqual([harness.ctx.cwd, harness.ctx.cwd]);
    expect(harness.events.filter((event) => event.type === 'step.scratch_files_left')).toHaveLength(
      0,
    );
    expect(harness.events.filter((event) => event.type === 'step.completed')).toHaveLength(1);
  });

  it('does not warn for a root-level untracked deliverable that the handler auto-commits', async () => {
    const harness = await makeHarness(
      { expected_files: ['src/declared.ts', 'deliverable.txt'] },
      '?? deliverable.txt\n',
    );
    harness.git.status = vi.fn(async (cwd: string) => {
      harness.git.statusCalls.push(cwd);
      const committed = harness.git.commits.some((c) => c.files?.includes('deliverable.txt'));
      return committed ? '' : '?? deliverable.txt\n';
    });
    harness.git.changedFilesResults.set('pre-step|post-step', ['src/declared.ts']);
    harness.git.changedFilesResults.set('pre-step|fake-sha-1', [
      'src/declared.ts',
      'deliverable.txt',
    ]);

    const result = await new ImplementHandler({
      steps: harness.steps,
      runStep: harness.runStep,
    }).run(harness.ctx);

    expect(result).toEqual({ outcome: 'passed' });
    expect(harness.git.statusCalls).toEqual([harness.ctx.cwd, harness.ctx.cwd]);
    expect(harness.git.addCalls).toEqual([{ cwd: harness.ctx.cwd, files: ['deliverable.txt'] }]);
    expect(harness.git.commits[0]?.files).toEqual(['deliverable.txt']);
    expect(harness.events.filter((event) => event.type === 'step.scratch_files_left')).toHaveLength(
      0,
    );
  });

  it('keeps a complete step successful when scratch status detection is unavailable', async () => {
    const harness = await makeHarness({ expected_files: ['src/declared.ts'] }, '');
    harness.git.changedFilesResults.set('pre-step|post-step', ['src/declared.ts']);
    const statusSpy = vi.spyOn(harness.git, 'status').mockRejectedValue(new Error('status failed'));

    const result = await new ImplementHandler({
      steps: harness.steps,
      runStep: harness.runStep,
    }).run(harness.ctx);

    expect(result).toMatchObject({
      outcome: 'failed',
      failure: expect.objectContaining({
        kind: 'unknown',
        message: expect.stringContaining('phase-boundary worktree check failed'),
      }),
    });
    expect(statusSpy).toHaveBeenCalledTimes(2);
    expect(harness.events.filter((event) => event.type === 'step.scratch_files_left')).toHaveLength(
      0,
    );
    expect(harness.events.filter((event) => event.type === 'step.completed')).toHaveLength(1);
    expect(harness.events.filter((event) => event.type === 'step.failed')).toHaveLength(0);
  });

  it('removes undeclared untracked root files from disk and records .ai-tmp/scratch-files.json artifact', async () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), 'scratch-test-'));
    try {
      const rootScratch = join(tmpCwd, 'test-ast.js');
      const nestedDir = join(tmpCwd, 'nested');
      mkdirSync(nestedDir, { recursive: true });
      const nestedScratch = join(nestedDir, 'deep-scratch.js');
      const protectedFile = join(tmpCwd, '.gitignore');

      writeFileSync(rootScratch, '// scratch file');
      writeFileSync(nestedScratch, '// nested file');
      writeFileSync(protectedFile, '# gitignore');

      const harness = await makeHarness(
        { expected_files: ['src/declared.ts'] },
        '?? test-ast.js\n?? nested/deep-scratch.js\n?? .gitignore',
      );
      harness.ctx.cwd = tmpCwd;
      harness.git.headByCwd.set(tmpCwd, 'pre-step');
      harness.git.statusByCwd.set(
        tmpCwd,
        '?? test-ast.js\n?? nested/deep-scratch.js\n?? .gitignore',
      );
      harness.git.changedFilesResults.set('pre-step|post-step', ['src/declared.ts']);

      const result = await new ImplementHandler({
        steps: harness.steps,
        runStep: harness.runStep,
      }).run(harness.ctx);

      expect(result).toMatchObject({ outcome: 'needs_human_review' });
      expect(existsSync(rootScratch)).toBe(false);
      expect(existsSync(nestedScratch)).toBe(true);
      expect(existsSync(protectedFile)).toBe(true);

      const artifactContent = await harness.artifacts.read(RUN_UUID, '.ai-tmp/scratch-files.json');
      const parsed = JSON.parse(artifactContent);
      expect(parsed).toEqual({
        steps: [
          {
            stepIndex: 1,
            totalSteps: 1,
            stepTitle: 'detect scratch files',
            files: ['nested/deep-scratch.js', 'test-ast.js'],
          },
        ],
      });
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('records subdirectory untracked files in .ai-tmp/scratch-files.json without deleting them from disk', async () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), 'subdir-scratch-'));
    try {
      const pkgDir = join(tmpCwd, 'packages', 'contracts');
      mkdirSync(pkgDir, { recursive: true });
      const subScratch = join(pkgDir, 'scratch.ts');
      writeFileSync(subScratch, 'export const probe = 1;');

      const harness = await makeHarness(
        { expected_files: ['src/declared.ts'] },
        '?? packages/contracts/scratch.ts',
      );
      harness.ctx.cwd = tmpCwd;
      harness.git.headByCwd.set(tmpCwd, 'pre-step');
      harness.git.statusByCwd.set(tmpCwd, '?? packages/contracts/scratch.ts');
      harness.git.changedFilesResults.set('pre-step|post-step', ['src/declared.ts']);

      const implementResult = await new ImplementHandler({
        steps: harness.steps,
        runStep: harness.runStep,
      }).run(harness.ctx);

      expect(implementResult).toMatchObject({ outcome: 'needs_human_review' });
      // Subdirectory file must NOT be deleted from disk
      expect(existsSync(subScratch)).toBe(true);

      // Artifact in .ai-tmp must contain the subdirectory file
      const artifactContent = await harness.artifacts.read(RUN_UUID, '.ai-tmp/scratch-files.json');
      const parsed = JSON.parse(artifactContent);
      expect(parsed.steps[0].files).toContain('packages/contracts/scratch.ts');
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('regression test (#922): step writes test-ast.js to root, step completes and cleans root, run reaches validate successfully', async () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), 'repro-922-'));
    try {
      const rootAstJs = join(tmpCwd, 'test-ast.js');
      const rootAstCjs = join(tmpCwd, 'test-ast.cjs');
      writeFileSync(rootAstJs, 'const ts = require("typescript");');
      writeFileSync(rootAstCjs, 'const ts = require("typescript");');

      const harness = await makeHarness(
        { expected_files: ['src/declared.ts'] },
        '?? test-ast.js\n?? test-ast.cjs',
      );
      harness.ctx.cwd = tmpCwd;
      harness.git.headByCwd.set(tmpCwd, 'pre-step');
      harness.git.status = vi.fn(async () => {
        const files = ['test-ast.js', 'test-ast.cjs'].filter((f) => existsSync(join(tmpCwd, f)));
        return files.map((f) => `?? ${f}`).join('\n');
      });
      harness.git.changedFilesResults.set('pre-step|post-step', ['src/declared.ts']);

      const implementResult = await new ImplementHandler({
        steps: harness.steps,
        runStep: harness.runStep,
      }).run(harness.ctx);

      expect(implementResult).toEqual({ outcome: 'passed' });
      expect(existsSync(rootAstJs)).toBe(false);
      expect(existsSync(rootAstCjs)).toBe(false);

      harness.git.statusByCwd.set(tmpCwd, '');

      const validationPort = new FakeValidationPort();
      validationPort.result = [
        {
          command: 'pnpm test',
          exitCode: 0,
          durationMs: 100,
          stdout: 'ok',
          stderr: '',
          stdoutPath: 'out',
          stderrPath: 'err',
          outcome: 'passed',
        },
      ];
      const runValidation = new RunValidation({
        validation: validationPort,
        validationRunRepository: new FakeValidationRunRepository(),
        idFactory: () => 'vr-922',
        now: () => new Date('2026-08-16T18:00:00.000Z'),
      });

      const validateResult = await new ValidateHandler({
        runValidation,
        commands: ['pnpm test'],
        timeoutSeconds: 60,
        logDir: tmpCwd,
        fixValidateEnabled: false,
      }).run(harness.ctx);

      expect(validateResult).toEqual({ outcome: 'passed' });
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('does not report or delete orchestrator artifacts at root even if untracked, while deleting genuine scratch files', async () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), 'orchestrator-artifacts-test-'));
    try {
      const planFile = join(tmpCwd, 'plan.md');
      const manifestFile = join(tmpCwd, 'task-manifest.json');
      const contextFile = join(tmpCwd, 'task-context-step-1.md');
      const stepHistoryFile = join(tmpCwd, 'implement-step-history-1.json');
      const genuineScratch = join(tmpCwd, 'scratch-tool.js');

      writeFileSync(planFile, '# Plan');
      writeFileSync(manifestFile, '{}');
      writeFileSync(contextFile, 'Context');
      writeFileSync(stepHistoryFile, '{}');
      writeFileSync(genuineScratch, 'console.log(1);');

      const harness = await makeHarness(
        { expected_files: ['src/declared.ts'] },
        '?? plan.md\n?? task-manifest.json\n?? task-context-step-1.md\n?? implement-step-history-1.json\n?? scratch-tool.js',
      );
      harness.ctx.cwd = tmpCwd;
      harness.git.headByCwd.set(tmpCwd, 'pre-step');
      harness.git.status = vi.fn(async () => {
        const files = [
          'plan.md',
          'task-manifest.json',
          'task-context-step-1.md',
          'implement-step-history-1.json',
          'scratch-tool.js',
        ].filter((f) => existsSync(join(tmpCwd, f)));
        return files.map((f) => `?? ${f}`).join('\n');
      });
      harness.git.changedFilesResults.set('pre-step|post-step', ['src/declared.ts']);

      const result = await new ImplementHandler({
        steps: harness.steps,
        runStep: harness.runStep,
      }).run(harness.ctx);

      expect(result).toEqual({ outcome: 'passed' });
      // Orchestrator artifacts must remain untouched
      expect(existsSync(planFile)).toBe(true);
      expect(existsSync(manifestFile)).toBe(true);
      expect(existsSync(contextFile)).toBe(true);
      expect(existsSync(stepHistoryFile)).toBe(true);

      // Genuine scratch file at root must be deleted
      expect(existsSync(genuineScratch)).toBe(false);

      // Warning should only contain genuine scratch file
      const warning = harness.events.find((e) => e.type === 'step.scratch_files_left');
      expect(warning).toBeDefined();
      expect(warning?.metadata).toMatchObject({
        files: ['scratch-tool.js'],
      });
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });
});
