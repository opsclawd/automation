import { describe, it, expect, vi } from 'vitest';
import { RunId, PhaseName, AgentProfileName } from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { FakeGitPort } from '../../test-doubles/fake-git-port.js';
import { FakeLoopRepository } from '../../test-doubles/fake-loop-repository.js';
import { FakeArtifactStore } from '../../test-doubles/fake-artifact-store.js';
import { FakeStepRepository } from '../../test-doubles/fake-step-repository.js';
import { ImplementStepLoop } from '../implement-step-loop.js';
import { ImplementHandler } from '../../phases/handlers/implement.js';
import type { PhaseHandlerContext } from '../../phases/handler.js';
import type {
  ImplementStepLoopDeps,
  ImplementResult,
  ImplementStepOptions,
  TypecheckResult,
  StepLoopContext,
  SpecReviewResult,
  QualityReviewResult,
  FixResult,
  ImplementFixStepOptions,
  ReviewScopeOptions,
} from '../types.js';
import type { EventBusPort } from '../../ports/event-bus-port.js';
import type { RevalidationResult } from '../../review-fix/types.js';
import type { TaskManifest } from '../../results/schemas/task-manifest.js';
import type { StepRunContext, StepRunResult } from '../../phases/handlers/implement.js';

const baseManifest: TaskManifest = {
  version: 2,
  task_count: 1,
  tasks: [
    {
      n: 1,
      title: 'Add the RED-first regression proof',
      expected_files: ['src/proof.test.ts'],
      reference_files: ['src/read-only.ts'],
      validation_commands: ['! pnpm test -- src/proof.test.ts'],
    },
  ],
};

interface HarnessOptions {
  manifest?: TaskManifest;
  changedFiles?: string[];
  revalidationResult?: RevalidationResult;
  initialPreStepHead?: string;
  exemptUndeclaredFiles?: string[];
  headSha?: string;
  stepIndex?: number;
  stepTitle?: string;
  completedStepIndexes?: number[];
}

function createHarness(options: HarnessOptions = {}) {
  const events: OrchestratorEvent[] = [];
  const eventsPort: EventBusPort = {
    publish: (_runUuid: string, e: OrchestratorEvent) => {
      events.push(e);
    },
    subscribe: () => () => {},
  };

  const git = new FakeGitPort();
  git.headByCwd.set('/wt', options.headSha ?? 'after-implement');
  if (options.changedFiles) {
    git.changedFilesResults.set('before-step|after-implement', [...options.changedFiles]);
    git.changedFilesResults.set('before-step|HEAD', [...options.changedFiles]);
  }

  const loops = new FakeLoopRepository();

  let specCallCount = 0;
  const runSpecReview = vi.fn(
    async (
      _ctx: StepLoopContext,
      _tcResult: TypecheckResult,
      _scope: ReviewScopeOptions,
    ): Promise<SpecReviewResult> => {
      specCallCount++;
      return {
        invocationId: `spec-${specCallCount}`,
        agentOutcome: 'success',
        verdict: 'pass',
        snapshot: { snapshot: 'spec-snap-1' },
      };
    },
  );

  let qualityCallCount = 0;
  const runQualityReview = vi.fn(
    async (
      _ctx: StepLoopContext,
      _tcResult: TypecheckResult,
      _scope: ReviewScopeOptions,
    ): Promise<QualityReviewResult> => {
      qualityCallCount++;
      return {
        invocationId: `qual-${qualityCallCount}`,
        agentOutcome: 'success',
        verdict: 'pass',
        snapshot: { snapshot: 'quality-snap-1' },
      };
    },
  );

  const runFix = vi.fn(
    async (_ctx: StepLoopContext, _opts: ImplementFixStepOptions): Promise<FixResult> => ({
      invocationId: 'fix-1',
      agentOutcome: 'success',
      verdict: 'done_with_fixes',
    }),
  );

  const defaultRevalidation: RevalidationResult = {
    validationRunId: 'validation-default',
    passed: true,
  };

  const runRevalidation = vi.fn(
    async (_ctx: StepLoopContext): Promise<RevalidationResult> =>
      options.revalidationResult ?? defaultRevalidation,
  );

  const runImplement = vi.fn(
    async (_ctx: StepLoopContext, _opts?: ImplementStepOptions): Promise<ImplementResult> => ({
      invocationId: 'impl-1',
      agentOutcome: 'success',
    }),
  );

  const runTypecheck = vi.fn(
    async (_ctx: StepLoopContext): Promise<TypecheckResult> => ({
      outcome: 'pass',
      output: '',
    }),
  );

  const deps: ImplementStepLoopDeps = {
    runImplement,
    runTypecheck,
    runSpecReview,
    runQualityReview,
    runFix,
    runRevalidation,
    implementProfile: AgentProfileName('test-profile'),
    fixProfile: AgentProfileName('fix-profile'),
    loops,
    events: eventsPort,
    git,
    now: () => new Date('2026-06-16T00:00:00Z'),
    idFactory: (() => {
      let id = 0;
      return () => `id-${++id}`;
    })(),
  };

  const loop = new ImplementStepLoop(deps);

  const input = {
    runId: RunId('run-1'),
    phaseId: PhaseName('implement'),
    repoId: 'acme/widgets',
    cwd: '/wt',
    stepIndex: options.stepIndex ?? 1,
    stepTitle: options.stepTitle ?? 'Add the RED-first regression proof',
    maxIterations: 3,
    manifest: options.manifest ?? baseManifest,
    planMd: '# Plan\n\n## Task 1: Add the RED-first regression proof\n',
    initialPreStepHead: options.initialPreStepHead ?? 'before-step',
    exemptUndeclaredFiles: options.exemptUndeclaredFiles ?? ['generated/allowed.ts'],
    ...(options.completedStepIndexes !== undefined
      ? { completedStepIndexes: options.completedStepIndexes }
      : {}),
  };

  return {
    loop,
    input,
    deps,
    git,
    events,
    runSpecReview,
    runQualityReview,
    runFix,
    runRevalidation,
    runImplement,
    runTypecheck,
  };
}

describe('ImplementStepLoop RED-first scope violation regression proof', () => {
  it('fails before review when a failed inverted command accompanies out-of-scope commits', async () => {
    // changed files intentionally include one expected file, one modified
    // reference, one undeclared file, one duplicate spelling, and one exemption
    // so the assertion locks normalized/sorted boundary semantics.
    const revalidationPayload = {
      validationRunId: 'validation-1',
      passed: false,
      failedCommands: ['! pnpm test -- src/proof.test.ts'],
    } as unknown as RevalidationResult;

    const harness = createHarness({
      changedFiles: [
        'src/proof.test.ts',
        'src/read-only.ts',
        './src/future-fix.ts',
        'src\\future-fix.ts',
        'generated/allowed.ts',
      ],
      revalidationResult: revalidationPayload,
    });

    const result = await harness.loop.execute(harness.input);

    expect(result.outcome).toBe('failed');
    expect(result.loop.status).toBe('failed');
    expect(result.loop.iterations).toHaveLength(1);
    expect(result.loop.iterations[0].outcome).toBe('failed');
    expect(result.loop.iterations[0].reviewInvocationId).toBe('');

    const failureMessage = (result as unknown as { failureMessage?: string }).failureMessage;
    expect(failureMessage).toBeDefined();
    expect(failureMessage).toContain('Task 1');
    expect(failureMessage).toContain('Add the RED-first regression proof');
    expect(failureMessage).toContain('! pnpm test -- src/proof.test.ts');
    expect(failureMessage).toContain('src/read-only.ts');
    expect(failureMessage).toContain('src/future-fix.ts');
    expect(failureMessage?.split('src/read-only.ts')).toHaveLength(2);
    expect(failureMessage?.split('src/future-fix.ts')).toHaveLength(2);
    expect(failureMessage).not.toContain('generated/allowed.ts');

    const redEvent = harness.events.find((e) => e.type === 'step.red_first_violation');
    expect(redEvent).toBeDefined();
    expect(redEvent?.metadata).toMatchObject({
      modifiedReferenceFiles: ['src/read-only.ts'],
      undeclaredFiles: ['src/future-fix.ts'],
      failedInvertedCommands: ['! pnpm test -- src/proof.test.ts'],
    });

    expect(harness.runSpecReview).not.toHaveBeenCalled();
    expect(harness.runQualityReview).not.toHaveBeenCalled();
    expect(harness.runFix).not.toHaveBeenCalled();
  });

  it('allows a genuine RED-first proof that changes only declared files to reach review', async () => {
    const revalidationPayload = {
      validationRunId: 'validation-1',
      passed: false,
      failedCommands: ['! pnpm test -- src/proof.test.ts'],
    } as unknown as RevalidationResult;

    const harness = createHarness({
      changedFiles: ['src/proof.test.ts'],
      revalidationResult: revalidationPayload,
    });

    const result = await harness.loop.execute(harness.input);

    expect(harness.runRevalidation).not.toHaveBeenCalled();
    expect(result.outcome).toBe('success');
    expect(harness.runSpecReview).toHaveBeenCalled();
    expect(harness.runQualityReview).toHaveBeenCalled();
    expect(harness.events.some((e) => e.type === 'step.red_first_violation')).toBe(false);
  });

  it('does not classify an unrelated validation failure as a RED-first violation', async () => {
    const revalidationPayload = {
      validationRunId: 'validation-1',
      passed: false,
      failedCommands: ['pnpm lint'],
    } as unknown as RevalidationResult;

    const harness = createHarness({
      changedFiles: ['src/proof.test.ts', 'src/future-fix.ts'],
      revalidationResult: revalidationPayload,
    });

    const result = await harness.loop.execute(harness.input);

    expect(result.outcome).toBe('success');
    expect(harness.runSpecReview).toHaveBeenCalled();
    expect(harness.runQualityReview).toHaveBeenCalled();
    expect(harness.events.some((e) => e.type === 'step.red_first_violation')).toBe(false);
    const failureMessage = (result as unknown as { failureMessage?: string }).failureMessage;
    expect(failureMessage).toBeUndefined();
  });

  it('does not run the RED-first guard for a task without an inverted command', async () => {
    const nonInvertedManifest: TaskManifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Add the RED-first regression proof',
          expected_files: ['src/proof.test.ts'],
          reference_files: ['src/read-only.ts'],
          validation_commands: ['pnpm test -- src/proof.test.ts'],
        },
      ],
    };

    const harness = createHarness({
      manifest: nonInvertedManifest,
      changedFiles: ['src/proof.test.ts', 'src/future-fix.ts'],
    });

    const result = await harness.loop.execute(harness.input);

    expect(harness.runRevalidation).not.toHaveBeenCalled();
    expect(result.outcome).toBe('success');
    expect(harness.runSpecReview).toHaveBeenCalled();
    expect(harness.runQualityReview).toHaveBeenCalled();
    expect(harness.events.some((e) => e.type === 'step.red_first_violation')).toBe(false);
  });

  it('propagates the RED-first violation through the implement phase failure', async () => {
    const artifacts = new FakeArtifactStore();
    const manifestJson = JSON.stringify(baseManifest);
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'task-manifest.json',
      contents: manifestJson,
    });
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: '# Plan\n\n## Task 1: Add the RED-first regression proof\n',
    });

    const steps = new FakeStepRepository();
    const events: OrchestratorEvent[] = [];
    const git = new FakeGitPort();
    git.headByCwd.set('/wt', 'pre-step-sha');

    const ctx: PhaseHandlerContext = {
      runId: 'run-1',
      runUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      repoFullName: 'acme/widgets',
      issueNumber: 42,
      cwd: '/wt',
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
      now: () => new Date('2026-06-16T00:00:00Z'),
      idFactory: (() => {
        let n = 0;
        return () => `id-${++n}`;
      })(),
    };

    const redMessage =
      'Task 1 (Add the RED-first regression proof) failed inverted command "! pnpm test -- src/proof.test.ts" while modifying read-only reference files: src/read-only.ts and undeclared files: src/future-fix.ts';

    const stepResult = {
      outcome: 'failed' as const,
      failureMessage: redMessage,
    };

    const runStep = vi
      .fn<(sctx: StepRunContext) => Promise<StepRunResult>>()
      .mockResolvedValue(stepResult);

    const result = await new ImplementHandler({ steps, runStep }).run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('invalid_result');
      expect(result.failure.message).toBe(redMessage);
    }

    const failedEvent = events.find((e) => e.type === 'implement.failed');
    expect(failedEvent).toBeDefined();
    expect(failedEvent?.message).toBe(redMessage);
  });

  it('allows a RED-first proof to carry inherited formatter-only edits from a completed task', async () => {
    const twoTaskManifest: TaskManifest = {
      version: 2,
      task_count: 2,
      tasks: [
        {
          n: 1,
          title: 'Write task 1',
          expected_files: ['src/earlier.ts'],
        },
        {
          n: 2,
          title: 'Add the RED-first regression proof',
          expected_files: ['src/proof.test.ts'],
          validation_commands: ['! pnpm test -- src/proof.test.ts'],
        },
      ],
    };

    const revalidationPayload = {
      validationRunId: 'validation-1',
      passed: false,
      failedCommands: ['! pnpm test -- src/proof.test.ts'],
    } as unknown as RevalidationResult;

    const harness = createHarness({
      manifest: twoTaskManifest,
      stepIndex: 2,
      stepTitle: 'Add the RED-first regression proof',
      completedStepIndexes: [1],
      changedFiles: ['src/proof.test.ts', 'src/earlier.ts'],
      revalidationResult: revalidationPayload,
    });

    harness.git.fileContentResults.set('before-step:src/earlier.ts', 'export const value={a:1}\n');
    harness.git.fileContentResults.set(
      'after-implement:src/earlier.ts',
      'export const value = { a: 1 };\n',
    );

    const result = await harness.loop.execute(harness.input);

    // failed inverted validation is expected for RED; formatting debt alone is not scope overreach
    expect(result.outcome).toBe('success');
    expect(harness.runSpecReview).toHaveBeenCalled();
    expect(harness.runQualityReview).toHaveBeenCalled();
    expect(harness.events.some((event) => event.type === 'step.red_first_violation')).toBe(false);
  });

  it("still rejects a RED-first proof that semantically changes a completed task's file", async () => {
    const twoTaskManifest: TaskManifest = {
      version: 2,
      task_count: 2,
      tasks: [
        {
          n: 1,
          title: 'Write task 1',
          expected_files: ['src/earlier.ts'],
        },
        {
          n: 2,
          title: 'Add the RED-first regression proof',
          expected_files: ['src/proof.test.ts'],
          reference_files: ['src/earlier.ts'],
          validation_commands: ['! pnpm test -- src/proof.test.ts'],
        },
      ],
    };

    const revalidationPayload = {
      validationRunId: 'validation-1',
      passed: false,
      failedCommands: ['! pnpm test -- src/proof.test.ts'],
    } as unknown as RevalidationResult;

    const harness = createHarness({
      manifest: twoTaskManifest,
      stepIndex: 2,
      stepTitle: 'Add the RED-first regression proof',
      completedStepIndexes: [1],
      changedFiles: ['src/proof.test.ts', 'src/earlier.ts'],
      revalidationResult: revalidationPayload,
    });

    harness.git.fileContentResults.set('before-step:src/earlier.ts', 'export const value = 1;\n');
    harness.git.fileContentResults.set(
      'after-implement:src/earlier.ts',
      'export const value = 2;\n',
    );

    const result = await harness.loop.execute(harness.input);

    expect(result.outcome).toBe('failed');
    expect(
      harness.events.find((event) => event.type === 'step.red_first_violation')?.metadata,
    ).toMatchObject({ modifiedReferenceFiles: ['src/earlier.ts'] });
  });

  it('allows formatter-only edits to reference files owned by an earlier completed task', async () => {
    const twoTaskManifestWithRef: TaskManifest = {
      version: 2,
      task_count: 2,
      tasks: [
        {
          n: 1,
          title: 'Write task 1',
          expected_files: ['src/earlier.ts'],
        },
        {
          n: 2,
          title: 'Add the RED-first regression proof',
          expected_files: ['src/proof.test.ts'],
          reference_files: ['src/earlier.ts'],
          validation_commands: ['! pnpm test -- src/proof.test.ts'],
        },
      ],
    };

    const revalidationPayload = {
      validationRunId: 'validation-1',
      passed: false,
      failedCommands: ['! pnpm test -- src/proof.test.ts'],
    } as unknown as RevalidationResult;

    const harness = createHarness({
      manifest: twoTaskManifestWithRef,
      stepIndex: 2,
      stepTitle: 'Add the RED-first regression proof',
      completedStepIndexes: [1],
      changedFiles: ['src/proof.test.ts', 'src/earlier.ts'],
      revalidationResult: revalidationPayload,
    });

    harness.git.fileContentResults.set('before-step:src/earlier.ts', 'export const value={a:1}\n');
    harness.git.fileContentResults.set(
      'after-implement:src/earlier.ts',
      'export const value = { a: 1 };\n',
    );

    const result = await harness.loop.execute(harness.input);

    expect(result.outcome).toBe('success');
    expect(harness.events.some((event) => event.type === 'step.red_first_violation')).toBe(false);
    expect(harness.runSpecReview).toHaveBeenCalled();
    expect(harness.runQualityReview).toHaveBeenCalled();
  });
});
