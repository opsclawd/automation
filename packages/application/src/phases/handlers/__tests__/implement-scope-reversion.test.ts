import { describe, it, expect, vi } from 'vitest';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { RunId, PhaseName } from '@ai-sdlc/domain';
import { ImplementHandler } from '../implement.js';
import type { StepRunContext, StepRunResult } from '../implement.js';
import { FakeArtifactStore } from '../../../test-doubles/fake-artifact-store.js';
import { FakeStepRepository } from '../../../test-doubles/fake-step-repository.js';
import { FakeGitPort } from '../../../test-doubles/fake-git-port.js';
import type { PhaseHandlerContext } from '../../handler.js';
import type {
  RevertScopeFilesInput,
  RevertScopeFilesPort,
  RevertScopeFilesResult,
} from '../../../ports/revert-scope-files-port.js';

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
      non_goals?: string[];
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

describe('ImplementHandler scope reversion and classify-repair-reclassify loop', () => {
  it('repairs drift, non-goal, premature, and undeclared protected paths in one deduplicated call', async () => {
    const artifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    const steps = new FakeStepRepository();
    const { ctx, events } = makeCtx(artifacts, git);

    await writePlanAndManifest(artifacts, {
      version: 2,
      task_count: 2,
      tasks: [
        {
          n: 1,
          title: 'Task 1: primary task',
          expected_files: ['src/task.ts'],
          non_goals: ['src/non-goal.ts'],
        },
        {
          n: 2,
          title: 'Task 2: downstream task',
          expected_files: ['src/downstream.ts'],
        },
      ],
    });

    git.headByCwd.set(ctx.cwd, 'pre-step');
    // Attempt 1 commits:
    // - declared src/task.ts
    // - non-goal src/non-goal.ts
    // - premature downstream src/downstream.ts
    // - drift src/drift.ts
    // - undeclared protected .gitignore
    git.changedFilesResults.set('pre-step|attempt-1', [
      'src/task.ts',
      'src/non-goal.ts',
      'src/downstream.ts',
      'src/drift.ts',
      '.gitignore',
    ]);
    git.changedFilesResults.set('pre-step|amended-1', ['src/task.ts']);
    git.changedFilesResults.set('pre-step|attempt-2', ['src/task.ts']);
    git.changedFilesResults.set('attempt-2|attempt-3', ['src/downstream.ts']);

    const revertScopeFiles = vi.fn(
      async (input: RevertScopeFilesInput): Promise<RevertScopeFilesResult> => {
        git.headByCwd.set(input.cwd, 'amended-1');
        return {
          revertedScopeFiles: [
            '.gitignore',
            'src/downstream.ts',
            'src/drift.ts',
            'src/non-goal.ts',
          ],
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
      maxDeclaredFilesRetries: 1,
      revertScopeFiles,
    }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(revertScopeFiles).toHaveBeenCalledTimes(1);
    expect(revertScopeFiles).toHaveBeenCalledWith({
      cwd: ctx.cwd,
      baseline: 'pre-step',
      expectedHeadSha: 'attempt-1',
      rewriteSafety: 'unpublished',
      scopeFiles: ['.gitignore', 'src/downstream.ts', 'src/drift.ts', 'src/non-goal.ts'],
    });

    expect(runStep).toHaveBeenCalledTimes(3);
    expect(events.filter((e) => e.type === 'step.completed')).toHaveLength(2);
  });

  it('adopts amendedHeadSha, refreshes status and created files, recomputes committedFiles, and reclassifies before downstream checks', async () => {
    const artifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    const steps = new FakeStepRepository();
    const { ctx } = makeCtx(artifacts, git);

    await writePlanAndManifest(artifacts, {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1: refresh check',
          expected_files: ['src/task.ts'],
        },
      ],
    });

    git.headByCwd.set(ctx.cwd, 'pre-step');
    git.statusByCwd.set(ctx.cwd, '?? dirty-untracked.ts\n');
    git.changedFilesResults.set('pre-step|attempt-1', ['src/task.ts', 'src/drift.ts']);
    git.createdFilesResults.set('pre-step|attempt-1', ['src/task.ts', 'src/drift.ts']);

    git.changedFilesResults.set('pre-step|amended-1', ['src/task.ts']);
    git.createdFilesResults.set('pre-step|amended-1', ['src/task.ts']);

    git.changedFilesResults.set('pre-step|attempt-2', ['src/task.ts']);

    const revertScopeFiles = vi.fn(
      async (input: RevertScopeFilesInput): Promise<RevertScopeFilesResult> => {
        git.headByCwd.set(input.cwd, 'amended-1');
        git.statusByCwd.set(input.cwd, ''); // Status refreshed
        return {
          revertedScopeFiles: ['src/drift.ts'],
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
      maxDeclaredFilesRetries: 1,
      revertScopeFiles,
    }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(revertScopeFiles).toHaveBeenCalledTimes(1);

    // Verify changedFiles and createdFiles queried amended SHA
    const changedFilesCalls = git.changedFilesCalls.filter((c) => c.head === 'amended-1');
    expect(changedFilesCalls.length).toBeGreaterThanOrEqual(1);

    const createdFilesCalls = git.createdFilesCalls.filter((c) => c.head === 'amended-1');
    expect(createdFilesCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('allows the second successful normalized-path repair after resume and persists count two while running', async () => {
    const artifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    const steps = new FakeStepRepository();
    const { ctx } = makeCtx(artifacts, git);

    // Pre-populate step with count 1
    steps.upsert({
      id: `${ctx.runUuid}:implement:1`,
      runId: ctx.runUuid,
      phaseId: 'implement',
      index: 1,
      title: 'Task 1: resume test',
      status: 'running',
      initialPreStepHead: 'pre-step',
      revertCounts: { 'src/drift.ts': 1 },
    });

    await writePlanAndManifest(artifacts, {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1: resume test',
          expected_files: ['src/task.ts'],
        },
      ],
    });

    git.headByCwd.set(ctx.cwd, 'pre-step');
    git.changedFilesResults.set('pre-step|attempt-1', ['src/task.ts', 'src/drift.ts']);
    git.changedFilesResults.set('pre-step|amended-1', ['src/task.ts']);
    git.changedFilesResults.set('pre-step|attempt-2', ['src/task.ts']);

    const revertScopeFiles = vi.fn(
      async (input: RevertScopeFilesInput): Promise<RevertScopeFilesResult> => {
        git.headByCwd.set(input.cwd, 'amended-1');
        return {
          revertedScopeFiles: ['src/drift.ts'],
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
      maxDeclaredFilesRetries: 1,
      revertScopeFiles,
    }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(revertScopeFiles).toHaveBeenCalledTimes(1);

    const step = steps.findByIndex(RunId(ctx.runUuid), PhaseName('implement'), 1);
    expect(step?.status).toBe('success');
    expect(step?.revertCounts['src/drift.ts']).toBe(2);
  });

  it('blocks the third normalized-path occurrence before rewrite and marks needs_human_review', async () => {
    const artifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    const steps = new FakeStepRepository();
    const { ctx } = makeCtx(artifacts, git);

    // Pre-populate step with count 2 (cap reached)
    steps.upsert({
      id: `${ctx.runUuid}:implement:1`,
      runId: ctx.runUuid,
      phaseId: 'implement',
      index: 1,
      title: 'Task 1: third occurrence check',
      status: 'running',
      initialPreStepHead: 'pre-step',
      revertCounts: { 'src/drift.ts': 2 },
    });

    await writePlanAndManifest(artifacts, {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1: third occurrence check',
          expected_files: ['src/task.ts'],
        },
      ],
    });

    git.headByCwd.set(ctx.cwd, 'pre-step');
    git.changedFilesResults.set('pre-step|attempt-1', ['src/task.ts', 'src/drift.ts']);

    const revertScopeFiles = vi.fn<RevertScopeFilesPort>();

    const runStep = vi.fn(async (): Promise<StepRunResult> => {
      git.headByCwd.set(ctx.cwd, 'attempt-1');
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 1,
      revertScopeFiles,
    }).run(ctx);

    expect(result.outcome).toBe('needs_human_review');
    expect(revertScopeFiles).not.toHaveBeenCalled();

    const step = steps.findByIndex(RunId(ctx.runUuid), PhaseName('implement'), 1);
    expect(step?.status).toBe('needs_human_review');
    expect(step?.revertCounts['src/drift.ts']).toBe(2);
  });

  it("does not charge an unrelated path for another path's repair budget", async () => {
    const artifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    const steps = new FakeStepRepository();
    const { ctx } = makeCtx(artifacts, git);

    // src/other.ts is at cap (2), but src/drift.ts is at 0
    steps.upsert({
      id: `${ctx.runUuid}:implement:1`,
      runId: ctx.runUuid,
      phaseId: 'implement',
      index: 1,
      title: 'Task 1: budget isolation',
      status: 'running',
      initialPreStepHead: 'pre-step',
      revertCounts: { 'src/other.ts': 2 },
    });

    await writePlanAndManifest(artifacts, {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1: budget isolation',
          expected_files: ['src/task.ts'],
        },
      ],
    });

    git.headByCwd.set(ctx.cwd, 'pre-step');
    git.changedFilesResults.set('pre-step|attempt-1', ['src/task.ts', 'src/drift.ts']);
    git.changedFilesResults.set('pre-step|amended-1', ['src/task.ts']);
    git.changedFilesResults.set('pre-step|attempt-2', ['src/task.ts']);

    const revertScopeFiles = vi.fn(
      async (input: RevertScopeFilesInput): Promise<RevertScopeFilesResult> => {
        git.headByCwd.set(input.cwd, 'amended-1');
        return {
          revertedScopeFiles: ['src/drift.ts'],
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
      maxDeclaredFilesRetries: 1,
      revertScopeFiles,
    }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(revertScopeFiles).toHaveBeenCalledTimes(1);

    const step = steps.findByIndex(RunId(ctx.runUuid), PhaseName('implement'), 1);
    expect(step?.status).toBe('success');
    expect(step?.revertCounts['src/other.ts']).toBe(2);
    expect(step?.revertCounts['src/drift.ts']).toBe(1);
  });

  it('normalization aliases and duplicate candidates increment one path exactly once', async () => {
    const artifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    const steps = new FakeStepRepository();
    const { ctx } = makeCtx(artifacts, git);

    await writePlanAndManifest(artifacts, {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1: normalization test',
          expected_files: ['src/task.ts'],
        },
      ],
    });

    git.headByCwd.set(ctx.cwd, 'pre-step');
    git.changedFilesResults.set('pre-step|attempt-1', ['src/task.ts', 'src/drift.ts']);
    git.changedFilesResults.set('pre-step|amended-1', ['src/task.ts']);
    git.changedFilesResults.set('pre-step|attempt-2', ['src/task.ts']);

    const revertScopeFiles = vi.fn(
      async (input: RevertScopeFilesInput): Promise<RevertScopeFilesResult> => {
        git.headByCwd.set(input.cwd, 'amended-1');
        return {
          revertedScopeFiles: ['src/drift.ts', './src/drift.ts', 'src//drift.ts'],
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
      maxDeclaredFilesRetries: 1,
      revertScopeFiles,
    }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(revertScopeFiles).toHaveBeenCalledTimes(1);

    const step = steps.findByIndex(RunId(ctx.runUuid), PhaseName('implement'), 1);
    expect(step?.revertCounts['src/drift.ts']).toBe(1);
    expect(step?.revertCounts['./src/drift.ts']).toBeUndefined();
  });

  it('failed or no-op repair does not increment counts and fails closed', async () => {
    const artifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    const steps = new FakeStepRepository();
    const { ctx } = makeCtx(artifacts, git);

    await writePlanAndManifest(artifacts, {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1: failed repair',
          expected_files: ['src/task.ts'],
        },
      ],
    });

    git.headByCwd.set(ctx.cwd, 'pre-step');
    git.changedFilesResults.set('pre-step|attempt-1', ['src/task.ts', 'src/drift.ts']);

    const revertScopeFiles = vi.fn(async () => {
      throw new Error('git amend failed');
    });

    const runStep = vi.fn(async (): Promise<StepRunResult> => {
      git.headByCwd.set(ctx.cwd, 'attempt-1');
      return { outcome: 'success' };
    });

    const result = await new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 1,
      revertScopeFiles,
    }).run(ctx);

    expect(result.outcome).toBe('failed');
    const step = steps.findByIndex(RunId(ctx.runUuid), PhaseName('implement'), 1);
    expect(step?.status).toBe('failed');
    expect(step?.revertCounts['src/drift.ts']).toBeUndefined();
  });

  it('reference-file faults take human-review precedence and missing expected files remain on the existing declared-file retry route', async () => {
    // 1. Reference file precedence
    const artifacts1 = new FakeArtifactStore();
    const git1 = new FakeGitPort();
    const steps1 = new FakeStepRepository();
    const { ctx: ctx1 } = makeCtx(artifacts1, git1);

    await writePlanAndManifest(artifacts1, {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1: ref fault with drift',
          expected_files: ['src/task.ts'],
          reference_files: ['src/ref.ts'],
        },
      ],
    });

    git1.headByCwd.set(ctx1.cwd, 'pre-step');
    git1.changedFilesResults.set('pre-step|attempt-1', [
      'src/task.ts',
      'src/ref.ts',
      'src/drift.ts',
    ]);

    const revertScopeFiles1 = vi.fn<RevertScopeFilesPort>();

    const runStep1 = vi.fn(async (): Promise<StepRunResult> => {
      git1.headByCwd.set(ctx1.cwd, 'attempt-1');
      return { outcome: 'success' };
    });

    const result1 = await new ImplementHandler({
      steps: steps1,
      runStep: runStep1,
      maxDeclaredFilesRetries: 1,
      revertScopeFiles: revertScopeFiles1,
    }).run(ctx1);

    expect(result1.outcome).toBe('needs_human_review');
    expect(revertScopeFiles1).not.toHaveBeenCalled();

    // 2. Missing expected files retry route
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
          title: 'Task 1: missing obligation',
          expected_files: ['src/task.ts', 'src/missing.ts'],
        },
      ],
    });

    git2.headByCwd.set(ctx2.cwd, 'pre-step');
    git2.changedFilesResults.set('pre-step|attempt-1', ['src/task.ts']);
    git2.changedFilesResults.set('pre-step|attempt-2', ['src/task.ts', 'src/missing.ts']);

    const revertScopeFiles2 = vi.fn<RevertScopeFilesPort>();

    let attempt2 = 0;
    const runStep2 = vi.fn(async (sctx: StepRunContext): Promise<StepRunResult> => {
      attempt2 += 1;
      if (attempt2 === 2) {
        expect(sctx.priorAttemptMissingFiles).toEqual(['src/missing.ts']);
      }
      git2.headByCwd.set(ctx2.cwd, `attempt-${attempt2}`);
      return { outcome: 'success' };
    });

    const result2 = await new ImplementHandler({
      steps: steps2,
      runStep: runStep2,
      maxDeclaredFilesRetries: 1,
      revertScopeFiles: revertScopeFiles2,
    }).run(ctx2);

    expect(result2.outcome).toBe('passed');
    expect(runStep2).toHaveBeenCalledTimes(2);
    expect(revertScopeFiles2).not.toHaveBeenCalled();
  });
});
