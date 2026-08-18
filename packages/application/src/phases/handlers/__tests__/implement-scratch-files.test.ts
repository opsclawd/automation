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
  it('warns with sorted undeclared root files without failing or deleting the step output', async () => {
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

    expect(result).toEqual({ outcome: 'passed' });
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
    expect(harness.git.statusCalls).toEqual([harness.ctx.cwd]);
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
    expect(harness.git.statusCalls).toEqual([harness.ctx.cwd]);
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

    expect(result).toEqual({ outcome: 'passed' });
    expect(statusSpy).toHaveBeenCalledTimes(1);
    expect(harness.events.filter((event) => event.type === 'step.scratch_files_left')).toHaveLength(
      0,
    );
    expect(harness.events.filter((event) => event.type === 'step.completed')).toHaveLength(1);
    expect(harness.events.filter((event) => event.type === 'step.failed')).toHaveLength(0);
  });

  it('removes undeclared untracked root files from disk and records scratch-files.json artifact', async () => {
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

      expect(result).toEqual({ outcome: 'passed' });

      expect(existsSync(rootScratch)).toBe(false);
      expect(existsSync(nestedScratch)).toBe(true);
      expect(existsSync(protectedFile)).toBe(true);

      const artifactContent = await harness.artifacts.read(RUN_UUID, '.ai-runs/scratch-files.json');
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
      harness.git.statusByCwd.set(tmpCwd, '?? test-ast.js\n?? test-ast.cjs');
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

  it('records subdirectory scratch files without deleting them and validate names the step', async () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), 'sub-scratch-test-'));
    try {
      const subDir = join(tmpCwd, 'packages', 'contracts');
      mkdirSync(subDir, { recursive: true });
      const subScratch = join(subDir, 'scratch.ts');
      writeFileSync(subScratch, 'console.log("scratch probe");');

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

      expect(implementResult).toEqual({ outcome: 'passed' });
      // Legitimate source or scratch in subdirectory is NOT deleted
      expect(existsSync(subScratch)).toBe(true);

      const artifactContent = await harness.artifacts.read(RUN_UUID, '.ai-runs/scratch-files.json');
      const parsed = JSON.parse(artifactContent);
      expect(parsed).toEqual({
        steps: [
          {
            stepIndex: 1,
            totalSteps: 1,
            stepTitle: 'detect scratch files',
            files: ['packages/contracts/scratch.ts'],
          },
        ],
      });

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
        idFactory: () => 'vr-sub',
        now: () => new Date('2026-08-16T18:00:00.000Z'),
      });

      const validateResult = await new ValidateHandler({
        runValidation,
        commands: ['pnpm test'],
        timeoutSeconds: 60,
        logDir: tmpCwd,
        fixValidateEnabled: false,
      }).run(harness.ctx);

      expect(validateResult).toEqual({
        outcome: 'failed',
        failure: expect.objectContaining({
          message:
            'Validation blocked by uncommitted source changes (reported by step 1): packages/contracts/scratch.ts',
        }),
      });
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });
});
