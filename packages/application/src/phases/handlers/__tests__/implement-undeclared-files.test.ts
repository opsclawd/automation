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
      reference_files?: string[];
      validation_commands?: string[];
    }>;
  },
  runUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
): Promise<void> {
  await artifacts.write({
    runId: runUuid,
    relativePath: 'plan.md',
    contents: planMd(
      manifest.tasks.map((t) =>
        t.title.startsWith('Task ') ? t.title : `Task ${t.n}: ${t.title}`,
      ),
    ),
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

  it('classifies a committed reference file separately from unrelated files', async () => {
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
          title: 'Task 1: reference vs unrelated',
          expected_files: ['src/task.ts'],
          reference_files: ['src/ref-b.ts', 'src/ref-a.ts'],
        },
      ],
    });

    git.headByCwd.set(ctx.cwd, 'pre-step');
    git.changedFilesResults.set('pre-step|attempt-1', [
      'src/task.ts',
      'src/ref-b.ts',
      'src/unrelated-z.ts',
      'src/unrelated-a.ts',
    ]);
    git.changedFilesResults.set('pre-step|attempt-2', ['src/task.ts']);

    const contexts: StepRunContext[] = [];
    const runStep = vi.fn(async (sctx: StepRunContext): Promise<StepRunResult> => {
      contexts.push(sctx);
      git.headByCwd.set(ctx.cwd, `attempt-${contexts.length}`);
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 1,
    }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(runStep).toHaveBeenCalledTimes(2);
    expect(contexts[0]?.priorAttemptModifiedReferenceFiles).toBeUndefined();
    expect(contexts[0]?.priorAttemptUndeclaredFiles).toBeUndefined();
    expect(contexts[1]?.priorAttemptModifiedReferenceFiles).toEqual(['src/ref-b.ts']);
    expect(contexts[1]?.priorAttemptUndeclaredFiles).toEqual([
      'src/unrelated-a.ts',
      'src/unrelated-z.ts',
    ]);

    const retryEvents = events.filter((e) => e.type === 'step.declared_files_retry');
    expect(retryEvents).toHaveLength(1);
    const retryMetadata = (retryEvents[0] as { metadata?: Record<string, unknown> }).metadata;
    expect(retryMetadata?.modifiedReferenceFiles).toEqual(['src/ref-b.ts']);
    expect(retryMetadata?.undeclaredFiles).toEqual(['src/unrelated-a.ts', 'src/unrelated-z.ts']);
  });

  it('reports unrelated committed files with the task identity', async () => {
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
          title: 'Task 1: enforce identity',
          expected_files: ['src/a.ts'],
        },
      ],
    });

    git.headByCwd.set(ctx.cwd, 'pre-step');
    git.changedFilesResults.set('pre-step|attempt-1', ['src/a.ts', 'src/extra.ts']);
    git.changedFilesResults.set('pre-step|attempt-2', ['src/a.ts']);

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
    const retryEvents = events.filter((e) => e.type === 'step.declared_files_retry');
    expect(retryEvents).toHaveLength(1);
    const meta = (retryEvents[0] as { metadata?: Record<string, unknown> }).metadata;
    expect(meta?.index).toBe(1);
    expect(meta?.undeclaredFiles).toEqual(['src/extra.ts']);
  });

  it('allows a committed expected file even when it is also a reference file', async () => {
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
          title: 'Task 1: overlapping expected and reference',
          expected_files: ['src/shared.ts'],
          reference_files: ['src/shared.ts'],
        },
      ],
    });

    git.headByCwd.set(ctx.cwd, 'pre-step');
    git.changedFilesResults.set('pre-step|attempt-1', ['src/shared.ts']);

    const runStep = vi.fn(async (): Promise<StepRunResult> => {
      git.headByCwd.set(ctx.cwd, 'attempt-1');
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 1,
    }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(runStep).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === 'step.declared_files_retry')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'step.completed')).toHaveLength(1);
  });

  it('allows only exact normalized exemption paths', async () => {
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
          title: 'Task 1: exact exemptions',
          expected_files: ['src/app.ts'],
        },
      ],
    });

    git.headByCwd.set(ctx.cwd, 'pre-step');
    git.changedFilesResults.set('pre-step|attempt-1', [
      'src/app.ts',
      './generated/client.ts',
      'generated/other.ts',
    ]);
    git.changedFilesResults.set('pre-step|attempt-2', ['src/app.ts', './generated/client.ts']);

    const contexts: StepRunContext[] = [];
    const runStep = vi.fn(async (sctx: StepRunContext): Promise<StepRunResult> => {
      contexts.push(sctx);
      git.headByCwd.set(ctx.cwd, `attempt-${contexts.length}`);
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 1,
      exemptUndeclaredFiles: ['generated/client.ts'],
    }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(runStep).toHaveBeenCalledTimes(2);
    expect(contexts[1]?.priorAttemptUndeclaredFiles).toEqual(['generated/other.ts']);
    expect(contexts[1]?.priorAttemptModifiedReferenceFiles).toBeUndefined();
    expect(events.filter((e) => e.type === 'step.declared_files_retry')).toHaveLength(1);
  });

  it('enforces declared surfaces without inventing one for manifest-less legacy plans', async () => {
    // Part A: V1 task with legacy `files`
    const artifacts1 = new FakeArtifactStore();
    const git1 = new FakeGitPort();
    const steps1 = new FakeStepRepository();
    const { ctx: ctx1 } = makeCtx(artifacts1, git1);

    await writePlanAndManifest(artifacts1, {
      version: 1,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1: v1 files',
          files: ['src/legacy.ts'],
        },
      ],
    });

    git1.headByCwd.set(ctx1.cwd, 'pre-step');
    git1.changedFilesResults.set('pre-step|attempt-1', ['src/legacy.ts', 'src/extra.ts']);
    git1.changedFilesResults.set('pre-step|attempt-2', ['src/legacy.ts']);

    let attempt1 = 0;
    const runStep1 = vi.fn(async (): Promise<StepRunResult> => {
      attempt1++;
      git1.headByCwd.set(ctx1.cwd, `attempt-${attempt1}`);
      return { outcome: 'success' };
    });

    const res1 = await new ImplementHandler({
      steps: steps1,
      runStep: runStep1,
      maxDeclaredFilesRetries: 1,
    }).run(ctx1);
    expect(res1.outcome).toBe('passed');
    expect(runStep1).toHaveBeenCalledTimes(2);

    // Part B: V2 task with empty expected_files
    const artifacts2 = new FakeArtifactStore();
    const git2 = new FakeGitPort();
    const steps2 = new FakeStepRepository();
    const { ctx: ctx2 } = makeCtx(artifacts2, git2);

    await writePlanAndManifest(artifacts2, {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1: empty surface v2',
          expected_files: [],
        },
      ],
    });

    git2.headByCwd.set(ctx2.cwd, 'pre-step');
    git2.changedFilesResults.set('pre-step|attempt-1', ['src/unexpected.ts']);
    git2.changedFilesResults.set('pre-step|attempt-2', []);

    let attempt2 = 0;
    const runStep2 = vi.fn(async (): Promise<StepRunResult> => {
      attempt2++;
      git2.headByCwd.set(ctx2.cwd, `attempt-${attempt2}`);
      return { outcome: 'success' };
    });

    const res2 = await new ImplementHandler({
      steps: steps2,
      runStep: runStep2,
      maxDeclaredFilesRetries: 1,
    }).run(ctx2);
    expect(res2.outcome).toBe('passed');
    expect(runStep2).toHaveBeenCalledTimes(2);

    // Part C: Manifest-less plan.md only
    const artifacts3 = new FakeArtifactStore();
    const git3 = new FakeGitPort();
    const steps3 = new FakeStepRepository();
    const { ctx: ctx3 } = makeCtx(artifacts3, git3);

    await artifacts3.write({
      runId: ctx3.runUuid,
      relativePath: 'plan.md',
      contents: planMd(['Task 1: legacy no manifest']),
    });

    const runStep3 = vi.fn(async (): Promise<StepRunResult> => {
      git3.headByCwd.set(ctx3.cwd, 'attempt-1');
      return { outcome: 'success' };
    });

    const res3 = await new ImplementHandler({
      steps: steps3,
      runStep: runStep3,
      maxDeclaredFilesRetries: 1,
    }).run(ctx3);
    expect(res3.outcome).toBe('passed');
    expect(runStep3).toHaveBeenCalledTimes(1);
  });

  it('preserves missing-file recovery while undeclared files still force retry', async () => {
    const artifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    const steps = new FakeStepRepository();
    const validationPort = new FakeValidationPort();
    const { ctx, events } = makeCtx(artifacts, git);

    await writePlanAndManifest(artifacts, {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1: unaffected missing but committed undeclared',
          expected_files: ['src/declared.ts', 'src/missing-unaffected.ts'],
          validation_commands: ['pnpm vitest run src/test.spec.ts'],
        },
      ],
    });

    git.headByCwd.set(ctx.cwd, 'pre-step');
    git.changedFilesResults.set('pre-step|attempt-1', ['src/declared.ts', 'src/extra.ts']);
    git.statusByCwd.set(ctx.cwd, '');
    git.changedFilesResults.set('pre-step|attempt-2', ['src/declared.ts']);

    validationPort.result = [
      {
        command: 'pnpm vitest run src/test.spec.ts',
        exitCode: 0,
        durationMs: 100,
        stdout: '',
        stderr: '',
        stdoutPath: '/tmp/stdout',
        stderrPath: '/tmp/stderr',
        outcome: 'passed',
      },
    ];
    const runWorkspaceTypecheck = vi.fn(async ({}: RunWorkspaceTypecheckInput) => ({ ok: true }));

    const contexts: StepRunContext[] = [];
    const runStep = vi.fn(async (sctx: StepRunContext): Promise<StepRunResult> => {
      contexts.push(sctx);
      git.headByCwd.set(ctx.cwd, `attempt-${contexts.length}`);
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      validationPort,
      runWorkspaceTypecheck,
      maxDeclaredFilesRetries: 1,
    }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(runStep).toHaveBeenCalledTimes(2);
    expect(contexts[1]?.priorAttemptMissingFiles).toBeUndefined();
    expect(contexts[1]?.priorAttemptUndeclaredFiles).toEqual(['src/extra.ts']);
    expect(events.filter((e) => e.type === 'step.unaffected_files_verified')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'step.declared_files_retry')).toHaveLength(1);
  });

  it('uses one declared-files retry for mixed boundary violations', async () => {
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
          title: 'Task 1: mixed violations',
          expected_files: ['src/expected.ts', 'src/missing.ts'],
          reference_files: ['src/ref.ts'],
        },
      ],
    });

    git.headByCwd.set(ctx.cwd, 'pre-step');
    git.changedFilesResults.set('pre-step|attempt-1', [
      'src/expected.ts',
      'src/ref.ts',
      'src/extra.ts',
    ]);
    git.changedFilesResults.set('pre-step|attempt-2', ['src/expected.ts', 'src/missing.ts']);

    const contexts: StepRunContext[] = [];
    const runStep = vi.fn(async (sctx: StepRunContext): Promise<StepRunResult> => {
      contexts.push(sctx);
      git.headByCwd.set(ctx.cwd, `attempt-${contexts.length}`);
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 1,
    }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(runStep).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.type === 'step.declared_files_retry')).toHaveLength(1);
    expect(contexts[1]?.priorAttemptMissingFiles).toEqual(['src/missing.ts']);
    expect(contexts[1]?.priorAttemptModifiedReferenceFiles).toEqual(['src/ref.ts']);
    expect(contexts[1]?.priorAttemptUndeclaredFiles).toEqual(['src/extra.ts']);
  });

  it('fails with all boundary violations after the retry budget is exhausted', async () => {
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
          title: 'exhaustive failure',
          expected_files: ['src/expected.ts', 'src/missing.ts'],
          reference_files: ['src/ref.ts'],
        },
      ],
    });

    git.headByCwd.set(ctx.cwd, 'pre-step');
    git.changedFilesResults.set('pre-step|attempt-1', [
      'src/expected.ts',
      'src/ref.ts',
      'src/extra.ts',
    ]);

    const runStep = vi.fn(async (): Promise<StepRunResult> => {
      git.headByCwd.set(ctx.cwd, 'attempt-1');
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 0,
    }).run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('invalid_result');
      expect(result.failure.message).toContain('step 1 (Task 1: exhaustive failure)');
      expect(result.failure.message).toContain('src/missing.ts');
      expect(result.failure.message).toContain('modified read-only reference files');
      expect(result.failure.message).toContain('src/ref.ts');
      expect(result.failure.message).toContain('committed undeclared files');
      expect(result.failure.message).toContain('src/extra.ts');
    }

    expect(events.filter((e) => e.type === 'step.uncommitted_files')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'step.failed')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'step.completed')).toHaveLength(0);
  });
});
