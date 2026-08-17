import { describe, it, expect, vi } from 'vitest';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { RunId } from '@ai-sdlc/domain';
import { ImplementHandler } from '../implement.js';
import type { StepRunContext, StepRunResult } from '../implement.js';
import { FakeArtifactStore } from '../../../test-doubles/fake-artifact-store.js';
import { FakeStepRepository } from '../../../test-doubles/fake-step-repository.js';
import { FakeGitPort } from '../../../test-doubles/fake-git-port.js';
import type { PhaseHandlerContext } from '../../handler.js';
import type {
  RevertProtectedFilesInput,
  RevertProtectedFilesPort,
  RevertProtectedFilesResult,
} from '../../../ports/protected-file-reverter-port.js';

function makeCtx(artifacts: FakeArtifactStore, git: FakeGitPort) {
  const events: OrchestratorEvent[] = [];
  const now = () => new Date('2026-08-16T12:00:00Z');
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

describe('ImplementHandler protected-file policy', () => {
  it('allows an exactly declared protected file without invoking repair', async () => {
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
          title: 'Task 1: modify declared .gitignore',
          expected_files: ['.gitignore', 'src/app.ts'],
        },
      ],
    });

    git.headByCwd.set(ctx.cwd, 'pre-step');
    git.changedFilesResults.set('pre-step|attempt-1', ['.gitignore', 'src/app.ts']);

    const revertProtectedFiles = vi.fn<RevertProtectedFilesPort>();

    const runStep = vi.fn(async (): Promise<StepRunResult> => {
      git.headByCwd.set(ctx.cwd, 'attempt-1');
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 1,
      revertProtectedFiles,
    }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(revertProtectedFiles).not.toHaveBeenCalled();
    expect(runStep).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === 'step.completed')).toHaveLength(1);
  });

  it('repairs an undeclared protected file before retrying the step', async () => {
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
          title: 'Task 1: undeclared protected mutation',
          expected_files: ['src/task.ts'],
        },
      ],
    });

    git.headByCwd.set(ctx.cwd, 'pre-step');
    git.statusByCwd.set(ctx.cwd, '?? scratch.txt\n');
    git.changedFilesResults.set('pre-step|attempt-1', ['src/task.ts', '.gitignore']);
    git.changedFilesResults.set('pre-step|amended-1', ['src/task.ts']);
    git.changedFilesResults.set('pre-step|attempt-2', ['src/task.ts']);

    const revertProtectedFiles = vi.fn(
      async (input: RevertProtectedFilesInput): Promise<RevertProtectedFilesResult> => {
        git.headByCwd.set(input.cwd, 'amended-1');
        git.statusByCwd.set(input.cwd, ''); // Status changed after repair
        return {
          revertedProtectedFiles: ['.gitignore'],
          removedNewlyIgnoredFiles: [],
          amendedHeadSha: 'amended-1',
        };
      },
    );

    const contexts: StepRunContext[] = [];
    let attempt = 0;
    const runStep = vi.fn(async (sctx: StepRunContext): Promise<StepRunResult> => {
      contexts.push(sctx);
      attempt += 1;
      git.headByCwd.set(ctx.cwd, `attempt-${attempt}`);
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 1,
      revertProtectedFiles,
    }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(revertProtectedFiles).toHaveBeenCalledTimes(1);
    expect(revertProtectedFiles).toHaveBeenCalledWith({
      cwd: ctx.cwd,
      baseline: 'pre-step',
      protectedFiles: ['.gitignore'],
    });

    expect(runStep).toHaveBeenCalledTimes(2);
    expect(contexts[1]?.priorAttemptRepairedProtectedFiles).toEqual(['.gitignore']);
    expect(contexts[1]?.priorAttemptUndeclaredFiles).toBeUndefined();

    const retryEvents = events.filter((e) => e.type === 'step.declared_files_retry');
    expect(retryEvents).toHaveLength(1);
  });

  it('protects config and github descendants using exact normalized path rules', async () => {
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
          title: 'Task 1: workflow authorization scope',
          expected_files: ['src/task.ts', '.github/workflows/ci.yml'],
        },
      ],
    });

    git.headByCwd.set(ctx.cwd, 'pre-step');
    // Attempt 1 commits:
    // - declared .github/workflows/ci.yml
    // - undeclared protected .github/workflows/deploy.yml (should be repaired)
    // - undeclared protected .ai-orchestrator.json (should be repaired)
    // - undeclared non-protected .github-actions.yml (should NOT be repaired, becomes undeclared)
    git.changedFilesResults.set('pre-step|attempt-1', [
      'src/task.ts',
      '.github/workflows/ci.yml',
      '.github/workflows/deploy.yml',
      '.ai-orchestrator.json',
      '.github-actions.yml',
    ]);
    git.changedFilesResults.set('pre-step|amended-1', [
      'src/task.ts',
      '.github/workflows/ci.yml',
      '.github-actions.yml',
    ]);
    git.changedFilesResults.set('pre-step|attempt-2', ['src/task.ts', '.github/workflows/ci.yml']);

    const revertProtectedFiles = vi.fn(
      async (input: RevertProtectedFilesInput): Promise<RevertProtectedFilesResult> => {
        git.headByCwd.set(input.cwd, 'amended-1');
        return {
          revertedProtectedFiles: ['.ai-orchestrator.json', '.github/workflows/deploy.yml'],
          removedNewlyIgnoredFiles: [],
          amendedHeadSha: 'amended-1',
        };
      },
    );

    const contexts: StepRunContext[] = [];
    let attempt = 0;
    const runStep = vi.fn(async (sctx: StepRunContext): Promise<StepRunResult> => {
      contexts.push(sctx);
      attempt += 1;
      git.headByCwd.set(ctx.cwd, `attempt-${attempt}`);
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 1,
      revertProtectedFiles,
    }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(revertProtectedFiles).toHaveBeenCalledTimes(1);
    expect(revertProtectedFiles).toHaveBeenCalledWith({
      cwd: ctx.cwd,
      baseline: 'pre-step',
      protectedFiles: ['.ai-orchestrator.json', '.github/workflows/deploy.yml'],
    });

    // Residual non-protected undeclared file .github-actions.yml passed into priorAttemptUndeclaredFiles
    expect(contexts[1]?.priorAttemptUndeclaredFiles).toEqual(['.github-actions.yml']);
    expect(contexts[1]?.priorAttemptRepairedProtectedFiles).toEqual([
      '.ai-orchestrator.json',
      '.github/workflows/deploy.yml',
    ]);

    const retryEvents = events.filter((e) => e.type === 'step.declared_files_retry');
    expect(retryEvents).toHaveLength(1);
  });

  it('reports the protected cause without re-listing repaired artifact consequences', async () => {
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
          title: 'Task 1: gitignore inversion consequence check',
          expected_files: ['src/feature.ts'],
        },
      ],
    });

    git.headByCwd.set(ctx.cwd, 'pre-step');
    // Pre-repair commit has .gitignore and newly un-ignored artifacts design.md and plan.md
    git.changedFilesResults.set('pre-step|attempt-1', [
      'src/feature.ts',
      '.gitignore',
      'design.md',
      'plan.md',
    ]);
    // Post-repair commit has only src/feature.ts (the artifacts were removed from git tracking and gitignore reverted)
    git.changedFilesResults.set('pre-step|amended-1', ['src/feature.ts']);
    git.changedFilesResults.set('pre-step|attempt-2', ['src/feature.ts']);

    const revertProtectedFiles = vi.fn(
      async (input: RevertProtectedFilesInput): Promise<RevertProtectedFilesResult> => {
        git.headByCwd.set(input.cwd, 'amended-1');
        return {
          revertedProtectedFiles: ['.gitignore'],
          removedNewlyIgnoredFiles: ['design.md', 'plan.md'],
          amendedHeadSha: 'amended-1',
        };
      },
    );

    const contexts: StepRunContext[] = [];
    let attempt = 0;
    const runStep = vi.fn(async (sctx: StepRunContext): Promise<StepRunResult> => {
      contexts.push(sctx);
      attempt += 1;
      git.headByCwd.set(ctx.cwd, `attempt-${attempt}`);
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 1,
      revertProtectedFiles,
    }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(contexts[1]?.priorAttemptRepairedProtectedFiles).toEqual(['.gitignore']);
    expect(contexts[1]?.priorAttemptUndeclaredFiles).toBeUndefined();

    const retryEvents = events.filter((e) => e.type === 'step.declared_files_retry');
    expect(retryEvents).toHaveLength(1);
    const event = retryEvents[0];
    const eventStr = JSON.stringify(event);
    expect(eventStr).toContain('.gitignore');
    expect(eventStr).toContain('2 artifacts');
  });

  it('completes after a repaired protected-file attempt is followed by a clean retry', async () => {
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
          title: 'Task 1: clean retry after repair',
          expected_files: ['src/task.ts'],
        },
      ],
    });

    git.headByCwd.set(ctx.cwd, 'pre-step');
    git.changedFilesResults.set('pre-step|attempt-1', ['src/task.ts', '.ai-orchestrator.json']);
    git.changedFilesResults.set('pre-step|amended-1', ['src/task.ts']);
    git.changedFilesResults.set('pre-step|attempt-2', ['src/task.ts']);

    const revertProtectedFiles = vi.fn(
      async (input: RevertProtectedFilesInput): Promise<RevertProtectedFilesResult> => {
        git.headByCwd.set(input.cwd, 'amended-1');
        return {
          revertedProtectedFiles: ['.ai-orchestrator.json'],
          removedNewlyIgnoredFiles: [],
          amendedHeadSha: 'amended-1',
        };
      },
    );

    let attempt = 0;
    const runStep = vi.fn(async (): Promise<StepRunResult> => {
      attempt += 1;
      git.headByCwd.set(ctx.cwd, `attempt-${attempt}`);
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 2,
      revertProtectedFiles,
    }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(runStep).toHaveBeenCalledTimes(2);

    const stepRecords = steps.listForRun(RunId(ctx.runUuid));
    const finalStep = stepRecords.find((s) => s.index === 1);
    expect(finalStep?.status).toBe('success');
    expect(events.filter((e) => e.type === 'step.completed')).toHaveLength(1);
  });

  it('fails closed when protected-file repair cannot amend the step', async () => {
    // Subcase 1: revertProtectedFiles dependency is absent
    const artifacts1 = new FakeArtifactStore();
    const git1 = new FakeGitPort();
    const steps1 = new FakeStepRepository();
    const { ctx: ctx1, events: events1 } = makeCtx(artifacts1, git1);

    await writePlanAndManifest(artifacts1, {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1: missing repair dependency',
          expected_files: ['src/task.ts'],
        },
      ],
    });

    git1.headByCwd.set(ctx1.cwd, 'pre-step');
    git1.changedFilesResults.set('pre-step|attempt-1', ['src/task.ts', '.gitignore']);

    const runStep1 = vi.fn(async (): Promise<StepRunResult> => {
      git1.headByCwd.set(ctx1.cwd, 'attempt-1');
      return { outcome: 'success' };
    });

    const result1 = await new ImplementHandler({
      steps: steps1,
      runStep: runStep1,
      maxDeclaredFilesRetries: 2,
      // revertProtectedFiles omitted
    }).run(ctx1);

    expect(result1.outcome).toBe('failed');
    expect(runStep1).toHaveBeenCalledTimes(1); // Never retries
    expect(events1.filter((e) => e.type === 'step.completed')).toHaveLength(0);
    expect(events1.filter((e) => e.type === 'step.failed')).toHaveLength(1);

    // Subcase 2: revertProtectedFiles throws
    const artifacts2 = new FakeArtifactStore();
    const git2 = new FakeGitPort();
    const steps2 = new FakeStepRepository();
    const { ctx: ctx2, events: events2 } = makeCtx(artifacts2, git2);

    await writePlanAndManifest(artifacts2, {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1: throwing repair dependency',
          expected_files: ['src/task.ts'],
        },
      ],
    });

    git2.headByCwd.set(ctx2.cwd, 'pre-step');
    git2.changedFilesResults.set('pre-step|attempt-1', ['src/task.ts', '.gitignore']);

    const runStep2 = vi.fn(async (): Promise<StepRunResult> => {
      git2.headByCwd.set(ctx2.cwd, 'attempt-1');
      return { outcome: 'success' };
    });

    const revertProtectedFiles2 = vi.fn(async () => {
      throw new Error('git commit --amend failed');
    });

    const result2 = await new ImplementHandler({
      steps: steps2,
      runStep: runStep2,
      maxDeclaredFilesRetries: 2,
      revertProtectedFiles: revertProtectedFiles2,
    }).run(ctx2);

    expect(result2.outcome).toBe('failed');
    expect(runStep2).toHaveBeenCalledTimes(1);
    expect(events2.filter((e) => e.type === 'step.completed')).toHaveLength(0);
    expect(events2.filter((e) => e.type === 'step.failed')).toHaveLength(1);
  });

  it('names the gitignore mutation and artifact count when the retry budget is exhausted', async () => {
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
          title: 'Task 1: exhausted retries with gitignore mutation',
          expected_files: ['src/task.ts'],
        },
      ],
    });

    git.headByCwd.set(ctx.cwd, 'pre-step');
    git.changedFilesResults.set('pre-step|attempt-1', [
      'src/task.ts',
      '.gitignore',
      'artifact1.md',
      'artifact2.md',
      'artifact3.md',
    ]);
    git.changedFilesResults.set('pre-step|amended-1', ['src/task.ts']);

    const revertProtectedFiles = vi.fn(
      async (input: RevertProtectedFilesInput): Promise<RevertProtectedFilesResult> => {
        git.headByCwd.set(input.cwd, 'amended-1');
        return {
          revertedProtectedFiles: ['.gitignore'],
          removedNewlyIgnoredFiles: ['artifact1.md', 'artifact2.md', 'artifact3.md'],
          amendedHeadSha: 'amended-1',
        };
      },
    );

    const runStep = vi.fn(async (): Promise<StepRunResult> => {
      git.headByCwd.set(ctx.cwd, 'attempt-1');
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 0, // No retry budget
      revertProtectedFiles,
    }).run(ctx);

    expect(result.outcome).toBe('failed');
    expect(runStep).toHaveBeenCalledTimes(1);
    if (result.outcome === 'failed') {
      expect(result.failure?.message).toContain(
        '.gitignore was modified without declaration, un-ignoring 3 artifacts; the protected change and artifacts were reverted',
      );
    }
    const failedEvents = events.filter((e) => e.type === 'step.failed');
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]?.message).toContain(
      '.gitignore was modified without declaration, un-ignoring 3 artifacts; the protected change and artifacts were reverted',
    );
  });

  it('escalates to needs_human_review when a protected file is declared as reference_files with configured repair', async () => {
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
          title: 'modify reference .gitignore',
          expected_files: ['src/task.ts'],
          reference_files: ['.gitignore'],
        },
      ],
    });

    git.headByCwd.set(ctx.cwd, 'pre-step');
    git.changedFilesResults.set('pre-step|attempt-1', ['src/task.ts', '.gitignore']);
    git.changedFilesResults.set('pre-step|amended-1', ['src/task.ts']);

    const revertProtectedFiles = vi.fn(
      async (input: RevertProtectedFilesInput): Promise<RevertProtectedFilesResult> => {
        git.headByCwd.set(input.cwd, 'amended-1');
        return {
          revertedProtectedFiles: ['.gitignore'],
          removedNewlyIgnoredFiles: [],
          amendedHeadSha: 'amended-1',
        };
      },
    );

    const runStep = vi.fn(async (): Promise<StepRunResult> => {
      git.headByCwd.set(ctx.cwd, 'attempt-1');
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 2,
      revertProtectedFiles,
    }).run(ctx);

    expect(result.outcome).toBe('needs_human_review');
    expect(runStep).toHaveBeenCalledTimes(1);
    expect(revertProtectedFiles).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === 'step.declared_files_retry')).toHaveLength(0);
    if (result.outcome === 'needs_human_review') {
      expect(result.failure.kind).toBe('needs_human_review');
      expect(result.failure.message).toBe(
        'step 1 (Task 1: modify reference .gitignore) modified reference_files .gitignore. This is a manifest fault: expected_files must include these files.',
      );
      expect(result.failure.artifacts).toEqual(['task-manifest.json']);
    }

    const stepEvents = events.filter((e) => e.type === 'step.needs_human_review');
    expect(stepEvents).toHaveLength(1);
    expect(stepEvents[0]?.metadata).toMatchObject({
      index: 1,
      total: 1,
      taskTitle: 'modify reference .gitignore',
      modifiedReferenceFiles: ['.gitignore'],
    });

    const phaseEvents = events.filter((e) => e.type === 'implement.needs_human_review');
    expect(phaseEvents).toHaveLength(1);
  });

  it('escalates to needs_human_review when a protected file is declared as reference_files without configured repair', async () => {
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
          title: 'modify reference .gitignore no repair adapter',
          expected_files: ['src/task.ts'],
          reference_files: ['.gitignore'],
        },
      ],
    });

    git.headByCwd.set(ctx.cwd, 'pre-step');
    git.changedFilesResults.set('pre-step|attempt-1', ['src/task.ts', '.gitignore']);

    const runStep = vi.fn(async (): Promise<StepRunResult> => {
      git.headByCwd.set(ctx.cwd, 'attempt-1');
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 2,
    }).run(ctx);

    expect(result.outcome).toBe('needs_human_review');
    expect(runStep).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === 'step.declared_files_retry')).toHaveLength(0);
    if (result.outcome === 'needs_human_review') {
      expect(result.failure.kind).toBe('needs_human_review');
      expect(result.failure.message).toBe(
        'step 1 (Task 1: modify reference .gitignore no repair adapter) modified reference_files .gitignore. This is a manifest fault: expected_files must include these files.',
      );
    }
  });

  it('surfaces both manifest fault and repair failure when protected reference_file repair throws', async () => {
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
          title: 'modify reference .gitignore throwing repair',
          expected_files: ['src/task.ts'],
          reference_files: ['.gitignore'],
        },
      ],
    });

    git.headByCwd.set(ctx.cwd, 'pre-step');
    git.changedFilesResults.set('pre-step|attempt-1', ['src/task.ts', '.gitignore']);

    const revertProtectedFiles = vi.fn(async () => {
      throw new Error('git commit --amend failed');
    });

    const runStep = vi.fn(async (): Promise<StepRunResult> => {
      git.headByCwd.set(ctx.cwd, 'attempt-1');
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 2,
      revertProtectedFiles,
    }).run(ctx);

    expect(result.outcome).toBe('needs_human_review');
    expect(runStep).toHaveBeenCalledTimes(1);
    expect(revertProtectedFiles).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === 'step.declared_files_retry')).toHaveLength(0);
    if (result.outcome === 'needs_human_review') {
      expect(result.failure.kind).toBe('needs_human_review');
      expect(result.failure.message).toContain('modified reference_files .gitignore');
      expect(result.failure.message).toContain(
        'protected file repair failed: git commit --amend failed',
      );
      expect(result.failure.artifacts).toEqual(['task-manifest.json']);
      expect(result.failure.suggestedAction).toContain(
        'Repair the protected path changes (.gitignore)',
      );
      expect(result.failure.suggestedAction).toContain('update task-manifest.json');
    }

    const stepEvents = events.filter((e) => e.type === 'step.needs_human_review');
    expect(stepEvents).toHaveLength(1);
    expect(stepEvents[0]?.message).toContain('modified reference files (.gitignore)');
    expect(stepEvents[0]?.message).toContain(
      'protected file repair failed: git commit --amend failed',
    );
    expect(stepEvents[0]?.metadata).toMatchObject({
      index: 1,
      total: 1,
      taskTitle: 'modify reference .gitignore throwing repair',
      modifiedReferenceFiles: ['.gitignore'],
      protectedRepairError: 'git commit --amend failed',
    });
  });
});
