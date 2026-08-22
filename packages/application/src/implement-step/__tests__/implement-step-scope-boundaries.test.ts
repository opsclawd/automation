import { describe, it, expect, vi } from 'vitest';
import { RunId, PhaseName, AgentProfileName } from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { FakeGitPort } from '../../test-doubles/fake-git-port.js';
import { FakeLoopRepository } from '../../test-doubles/fake-loop-repository.js';
import { ImplementStepLoop } from '../implement-step-loop.js';
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

interface HarnessOptions {
  manifest?: TaskManifest;
  changedFiles?: string[];
  createdFiles?: string[];
  statusOutput?: string;
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
  const created = options.createdFiles ?? options.changedFiles;
  if (created) {
    git.createdFilesResults.set('before-step|after-implement', [...created]);
    git.createdFilesResults.set('before-step|HEAD', [...created]);
  }
  if (options.statusOutput !== undefined) {
    git.statusByCwd.set('/wt', options.statusOutput);
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

  const defaultManifest: TaskManifest = {
    version: 2,
    task_count: 1,
    tasks: [
      {
        n: 1,
        title: 'Task 1: Add regression proof',
        expected_files: ['src/proof.test.ts'],
        validation_commands: ['! pnpm test -- src/proof.test.ts'],
      },
    ],
  };

  const input = {
    runId: RunId('run-1'),
    phaseId: PhaseName('implement'),
    repoId: 'acme/widgets',
    cwd: '/wt',
    stepIndex: options.stepIndex ?? 1,
    stepTitle: options.stepTitle ?? 'Task 1: Add regression proof',
    maxIterations: 3,
    manifest: options.manifest ?? defaultManifest,
    planMd: '# Plan\n\n## Task 1: Add regression proof\n',
    initialPreStepHead: options.initialPreStepHead ?? 'before-step',
    ...(options.exemptUndeclaredFiles
      ? { exemptUndeclaredFiles: options.exemptUndeclaredFiles }
      : {}),
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

describe('ImplementStepLoop Scope Boundaries', () => {
  // Invariant 1: loop-shared-authority
  it('RED-first boundary enforcement classifies candidates through effective task scope', async () => {
    const manifest: TaskManifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Add regression proof',
          expected_files: ['src/proof.test.ts'],
          may_extend: ['src/allowed-opt.ts'],
          permitted_areas: ['src/feature'],
          validation_commands: ['! pnpm test -- src/proof.test.ts'],
        },
      ],
    };

    const revalidationPayload = {
      validationRunId: 'validation-1',
      passed: false,
      failedCommands: ['! pnpm test -- src/proof.test.ts'],
    } as RevalidationResult;

    // Subcase A: All candidates are within effective task scope (expected, may_extend, tracked area file)
    const permittedHarness = createHarness({
      manifest,
      changedFiles: ['src/proof.test.ts', 'src/allowed-opt.ts', 'src/feature/helper.ts'],
      createdFiles: ['src/proof.test.ts'], // helper.ts and allowed-opt.ts are tracked existing files
      revalidationResult: revalidationPayload,
    });

    const permittedResult = await permittedHarness.loop.execute(permittedHarness.input);
    expect(permittedResult.outcome).toBe('success');
    expect(permittedHarness.runSpecReview).toHaveBeenCalled();
    expect(permittedHarness.runQualityReview).toHaveBeenCalled();
    expect(permittedHarness.events.some((e) => e.type === 'step.red_first_violation')).toBe(false);

    // Subcase B: Candidate includes an unpermitted drift file
    const driftHarness = createHarness({
      manifest,
      changedFiles: ['src/proof.test.ts', 'src/unauthorized.ts'],
      createdFiles: ['src/proof.test.ts', 'src/unauthorized.ts'],
      revalidationResult: revalidationPayload,
    });

    const driftResult = await driftHarness.loop.execute(driftHarness.input);
    expect(driftResult.outcome).toBe('recoverable_scope_violation');
    expect(driftHarness.runSpecReview).not.toHaveBeenCalled();
    const failureMessage = (driftResult as unknown as { failureMessage?: string }).failureMessage;
    expect(failureMessage).toBeDefined();
    expect(failureMessage).toContain('src/unauthorized.ts');

    const redEvent = driftHarness.events.find((e) => e.type === 'step.red_first_violation');
    expect(redEvent).toBeDefined();
    expect(redEvent?.metadata).toMatchObject({
      driftFiles: ['src/unauthorized.ts'],
      failedInvertedCommands: ['! pnpm test -- src/proof.test.ts'],
    });
  });

  // Invariant 2: loop-downstream-precedence
  it('broad current area cannot authorize a downstream expected file', async () => {
    const manifest: TaskManifest = {
      version: 2,
      task_count: 2,
      tasks: [
        {
          n: 1,
          title: 'Task 1: Add regression proof',
          expected_files: ['src/task1.test.ts'],
          permitted_areas: ['src/components'],
          validation_commands: ['! pnpm test -- src/task1.test.ts'],
        },
        {
          n: 2,
          title: 'Task 2: Implement downstream component',
          expected_files: ['src/components/button.ts'],
          validation_commands: ['pnpm test'],
        },
      ],
    };

    const revalidationPayload = {
      validationRunId: 'validation-1',
      passed: false,
      failedCommands: ['! pnpm test -- src/task1.test.ts'],
    } as RevalidationResult;

    const harness = createHarness({
      manifest,
      stepIndex: 1,
      stepTitle: 'Task 1: Add regression proof',
      changedFiles: ['src/task1.test.ts', 'src/components/button.ts'],
      createdFiles: ['src/task1.test.ts', 'src/components/button.ts'],
      revalidationResult: revalidationPayload,
    });

    const result = await harness.loop.execute(harness.input);

    expect(result.outcome).toBe('recoverable_scope_violation');
    expect(harness.runSpecReview).not.toHaveBeenCalled();

    const failureMessage = (result as unknown as { failureMessage?: string }).failureMessage;
    expect(failureMessage).toBeDefined();
    expect(failureMessage).toContain(
      'premature implementation: src/components/button.ts (owned by task 2)',
    );
    expect(failureMessage).toContain('Separate the regression proof from its implementation');

    const redEvent = harness.events.find((e) => e.type === 'step.red_first_violation');
    expect(redEvent).toBeDefined();
    expect(redEvent?.metadata).toMatchObject({
      prematureImplementation: [{ path: 'src/components/button.ts', taskNumber: 2 }],
      failedInvertedCommands: ['! pnpm test -- src/task1.test.ts'],
    });
  });

  // Invariant 3: loop-reference-precedence
  it('may_extend or area cannot override a legacy reference declaration', async () => {
    const manifest: TaskManifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1: Regression proof',
          expected_files: ['src/proof.test.ts'],
          reference_files: ['src/legacy-ref.ts'],
          may_extend: ['src/legacy-ref.ts'],
          permitted_areas: ['src'],
          validation_commands: ['! pnpm test -- src/proof.test.ts'],
        },
      ],
    };

    const revalidationPayload = {
      validationRunId: 'validation-1',
      passed: false,
      failedCommands: ['! pnpm test -- src/proof.test.ts'],
    } as RevalidationResult;

    const harness = createHarness({
      manifest,
      stepIndex: 1,
      stepTitle: 'Task 1: Regression proof',
      changedFiles: ['src/proof.test.ts', 'src/legacy-ref.ts'],
      createdFiles: ['src/proof.test.ts'],
      revalidationResult: revalidationPayload,
    });

    const result = await harness.loop.execute(harness.input);

    expect(result.outcome).toBe('needs_human_review');
    expect(result.failureKind).toBe('needs_human_review');
    expect(result.modifiedReferenceFiles).toEqual(['src/legacy-ref.ts']);
    expect(harness.runSpecReview).not.toHaveBeenCalled();

    const failureMessage = (result as unknown as { failureMessage?: string }).failureMessage;
    expect(failureMessage).toBeDefined();
    expect(failureMessage).toContain(
      'step 1 (Task 1: Regression proof) modified reference_files src/legacy-ref.ts. This is a manifest fault: expected_files must include these files.',
    );

    const redEvent = harness.events.find((e) => e.type === 'step.red_first_violation');
    expect(redEvent).toBeDefined();
    expect(redEvent?.metadata).toMatchObject({
      modifiedReferenceFiles: ['src/legacy-ref.ts'],
    });
  });

  // Invariant 4: loop-legacy-compatibility
  it('V1 files and older V2 expected_files retain derived sibling edit permission', async () => {
    const revalidationPayload = {
      validationRunId: 'validation-1',
      passed: false,
      failedCommands: ['! pnpm test -- src/feature/entry.test.ts'],
    } as RevalidationResult;

    // Subcase A: V1 manifest with `files`
    const v1Manifest = {
      version: 1,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'V1 Task',
          files: ['src/feature/entry.test.ts'],
          validation: ['! pnpm test -- src/feature/entry.test.ts'],
        },
      ],
    } as unknown as TaskManifest;

    const v1Harness = createHarness({
      manifest: v1Manifest,
      stepIndex: 1,
      stepTitle: 'V1 Task',
      changedFiles: ['src/feature/entry.test.ts', 'src/feature/sibling.ts'],
      createdFiles: ['src/feature/entry.test.ts'], // sibling.ts is an existing tracked file
      revalidationResult: revalidationPayload,
    });

    const v1Result = await v1Harness.loop.execute(v1Harness.input);
    expect(v1Result.outcome).toBe('success');
    expect(v1Harness.runSpecReview).toHaveBeenCalled();
    expect(v1Harness.events.some((e) => e.type === 'step.red_first_violation')).toBe(false);

    // Subcase B: V2 manifest with `expected_files`
    const v2Manifest: TaskManifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'V2 Task',
          expected_files: ['src/feature/entry.test.ts'],
          validation_commands: ['! pnpm test -- src/feature/entry.test.ts'],
        },
      ],
    };

    const v2Harness = createHarness({
      manifest: v2Manifest,
      stepIndex: 1,
      stepTitle: 'V2 Task',
      changedFiles: ['src/feature/entry.test.ts', 'src/feature/sibling.ts'],
      createdFiles: ['src/feature/entry.test.ts'], // sibling.ts is an existing tracked file
      revalidationResult: revalidationPayload,
    });

    const v2Result = await v2Harness.loop.execute(v2Harness.input);
    expect(v2Result.outcome).toBe('success');
    expect(v2Harness.runSpecReview).toHaveBeenCalled();
    expect(v2Harness.events.some((e) => e.type === 'step.red_first_violation')).toBe(false);
  });

  // Invariant 5: loop-area-untracked-drift
  it('area-only untracked creation remains out of scope in the implement loop', async () => {
    const manifest: TaskManifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1: Add regression proof',
          expected_files: ['src/proof.test.ts'],
          permitted_areas: ['src/feature'],
          validation_commands: ['! pnpm test -- src/proof.test.ts'],
        },
      ],
    };

    const revalidationPayload = {
      validationRunId: 'validation-1',
      passed: false,
      failedCommands: ['! pnpm test -- src/proof.test.ts'],
    } as RevalidationResult;

    // Untracked file created in working tree within permitted area
    const harness = createHarness({
      manifest,
      stepIndex: 1,
      stepTitle: 'Task 1: Add regression proof',
      changedFiles: ['src/proof.test.ts'],
      createdFiles: ['src/proof.test.ts'],
      statusOutput: '?? src/feature/new-untracked.ts\n',
      revalidationResult: revalidationPayload,
    });

    const result = await harness.loop.execute(harness.input);

    expect(result.outcome).toBe('recoverable_scope_violation');
    expect(harness.runSpecReview).not.toHaveBeenCalled();

    const failureMessage = (result as unknown as { failureMessage?: string }).failureMessage;
    expect(failureMessage).toBeDefined();
    expect(failureMessage).toContain('src/feature/new-untracked.ts');

    const redEvent = harness.events.find((e) => e.type === 'step.red_first_violation');
    expect(redEvent).toBeDefined();
    expect(redEvent?.metadata).toMatchObject({
      driftFiles: ['src/feature/new-untracked.ts'],
      failedInvertedCommands: ['! pnpm test -- src/proof.test.ts'],
    });
  });
});
