import { describe, it, expect, vi } from 'vitest';
import { RunId, PhaseName, AgentProfileName } from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { FakeGitPort } from '../../test-doubles/fake-git-port.js';
import { FakeLoopRepository } from '../../test-doubles/fake-loop-repository.js';
import { ImplementStepLoop } from '../implement-step-loop.js';
import type {
  ImplementStepLoopDeps,
  ImplementStepLoopResult,
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

const twoTaskManifestWithPremature: TaskManifest = {
  version: 2,
  task_count: 2,
  tasks: [
    {
      n: 1,
      title: 'Add the RED-first regression proof',
      expected_files: ['src/proof.test.ts'],
      reference_files: ['src/read-only.ts'],
      validation_commands: ['! pnpm test -- src/proof.test.ts'],
    },
    {
      n: 2,
      title: 'Implement the fix in future task',
      expected_files: ['src/future-fix.ts'],
      validation_commands: ['pnpm test -- src/proof.test.ts'],
    },
  ],
};

interface HarnessOptions {
  manifest?: TaskManifest;
  changedFiles?: string[];
  createdFiles?: string[];
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
  it('keeps modified reference files on the human-review path even with premature changes', async () => {
    // changed files intentionally include one expected file, one modified
    // reference, one premature future-task file, one duplicate spelling, and one exemption
    // so the assertion locks reference-fault precedence over recoverable premature changes.
    const revalidationPayload = {
      validationRunId: 'validation-1',
      passed: false,
      failedCommands: ['! pnpm test -- src/proof.test.ts'],
    } as RevalidationResult;

    const harness = createHarness({
      manifest: twoTaskManifestWithPremature,
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

    expect(result.outcome).toBe('needs_human_review');
    expect(result.loop.status).toBe('failed');
    expect(result.loop.iterations).toHaveLength(1);
    expect(result.loop.iterations[0].outcome).toBe('failed');
    expect(result.loop.iterations[0].reviewInvocationId).toBe('');
    expect(result.failureKind).toBe('needs_human_review');
    expect(result.modifiedReferenceFiles).toEqual(['src/read-only.ts']);

    const failureMessage = (result as unknown as { failureMessage?: string }).failureMessage;
    expect(failureMessage).toBeDefined();
    expect(failureMessage).toContain(
      'step 1 (Add the RED-first regression proof) modified reference_files src/read-only.ts. This is a manifest fault: expected_files must include these files.',
    );

    const redEvent = harness.events.find((e) => e.type === 'step.red_first_violation');
    expect(redEvent).toBeDefined();
    expect(redEvent?.metadata).toMatchObject({
      modifiedReferenceFiles: ['src/read-only.ts'],
      prematureImplementation: [{ path: 'src/future-fix.ts', taskNumber: 2 }],
      failedInvertedCommands: ['! pnpm test -- src/proof.test.ts'],
    });

    expect(harness.runSpecReview).not.toHaveBeenCalled();
    expect(harness.runQualityReview).not.toHaveBeenCalled();
    expect(harness.runFix).not.toHaveBeenCalled();
  });

  it('keeps non-scope implementation failures terminal', async () => {
    const revalidationPayload = {
      validationRunId: 'validation-1',
      passed: false,
      failedCommands: ['! pnpm test -- src/proof.test.ts'],
    } as RevalidationResult;

    const harness = createHarness({
      manifest: twoTaskManifestWithPremature,
      changedFiles: ['src/proof.test.ts', 'src/future-fix.ts'],
      revalidationResult: revalidationPayload,
    });

    harness.runImplement.mockResolvedValueOnce({
      invocationId: 'impl-fail',
      agentOutcome: 'failed',
    });

    const result = await harness.loop.execute(harness.input);

    expect(result.outcome).toBe('failed');
    expect(result.loop.status).toBe('failed');
    expect(result.loop.iterations).toHaveLength(1);
    expect(result.loop.iterations[0].outcome).toBe('failed');
    expect(result.loop.iterations[0].reviewInvocationId).toBe('');
    expect(harness.runRevalidation).not.toHaveBeenCalled();
    expect(harness.runSpecReview).not.toHaveBeenCalled();
    expect(harness.runQualityReview).not.toHaveBeenCalled();
    expect(harness.runFix).not.toHaveBeenCalled();
    expect(harness.events.some((e) => e.type === 'step.red_first_violation')).toBe(false);
  });

  it('fails before review when a failed inverted command accompanies purely undeclared commits', async () => {
    const revalidationPayload = {
      validationRunId: 'validation-1',
      passed: false,
      failedCommands: ['! pnpm test -- src/proof.test.ts'],
    } as RevalidationResult;

    const harness = createHarness({
      changedFiles: [
        'src/proof.test.ts',
        './src/future-fix.ts',
        'src\\future-fix.ts',
        'generated/allowed.ts',
      ],
      revalidationResult: revalidationPayload,
    });

    const result = await harness.loop.execute(harness.input);

    expect(result.outcome).toBe('recoverable_scope_violation');
    expect(result.loop.status).toBe('failed');
    expect(result.loop.iterations).toHaveLength(1);
    expect(result.loop.iterations[0].outcome).toBe('failed');
    expect(result.loop.iterations[0].reviewInvocationId).toBe('');

    const failureMessage = (result as unknown as { failureMessage?: string }).failureMessage;
    expect(failureMessage).toBeDefined();
    expect(failureMessage).toContain('Task 1');
    expect(failureMessage).toContain('Add the RED-first regression proof');
    expect(failureMessage).toContain('! pnpm test -- src/proof.test.ts');
    expect(failureMessage).toContain('src/future-fix.ts');
    expect(failureMessage).not.toContain('src/read-only.ts');
    expect(failureMessage).not.toContain('generated/allowed.ts');

    const redEvent = harness.events.find((e) => e.type === 'step.red_first_violation');
    expect(redEvent).toBeDefined();
    expect(redEvent?.metadata).toMatchObject({
      modifiedReferenceFiles: [],
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
    } as RevalidationResult;

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
    } as RevalidationResult;

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
    } as RevalidationResult;

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
    } as RevalidationResult;

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

    expect(result.outcome).toBe('needs_human_review');
    expect(result.failureKind).toBe('needs_human_review');
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
    } as RevalidationResult;

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

  it('returns a recoverable scope violation for premature implementation and skips review work', async () => {
    const revalidationPayload = {
      validationRunId: 'validation-1',
      passed: false,
      failedCommands: ['! pnpm test -- src/proof.test.ts'],
    } as RevalidationResult;

    const harness = createHarness({
      manifest: twoTaskManifestWithPremature,
      changedFiles: [
        'src/proof.test.ts',
        './src/future-fix.ts',
        'src\\future-fix.ts',
        'generated/allowed.ts',
      ],
      revalidationResult: revalidationPayload,
    });

    const result: ImplementStepLoopResult = await harness.loop.execute(harness.input);

    expect(result.outcome).toBe('recoverable_scope_violation');
    expect(result.loop.status).toBe('failed');
    expect(result.loop.iterations).toHaveLength(1);
    expect(result.loop.iterations[0].outcome).toBe('failed');
    expect(result.loop.iterations[0].reviewInvocationId).toBe('');
    expect(result.prematureImplementation).toEqual([{ path: 'src/future-fix.ts', taskNumber: 2 }]);

    expect(result.failureMessage).toBeDefined();
    expect(result.failureMessage).toContain('Task 1');
    expect(result.failureMessage).toContain('Add the RED-first regression proof');
    expect(result.failureMessage).toContain('! pnpm test -- src/proof.test.ts');
    expect(result.failureMessage).toContain('src/future-fix.ts (owned by task 2)');

    const redEvent = harness.events.find((e) => e.type === 'step.red_first_violation');
    expect(redEvent).toBeDefined();
    expect(redEvent?.metadata).toMatchObject({
      prematureImplementation: [{ path: 'src/future-fix.ts', taskNumber: 2 }],
      failedInvertedCommands: ['! pnpm test -- src/proof.test.ts'],
    });

    expect(harness.runSpecReview).not.toHaveBeenCalled();
    expect(harness.runQualityReview).not.toHaveBeenCalled();
    expect(harness.runFix).not.toHaveBeenCalled();
  });

  it('hands mixed drift non-goal protected and premature changes to outer recovery', async () => {
    const mixedManifest: TaskManifest = {
      version: 2,
      task_count: 2,
      tasks: [
        {
          n: 1,
          title: 'Add the RED-first regression proof',
          expected_files: ['src/proof.test.ts'],
          non_goals: ['src/non-goal.ts'],
          validation_commands: ['! pnpm test -- src/proof.test.ts'],
        },
        {
          n: 2,
          title: 'Implement the fix in future task',
          expected_files: ['src/future-fix.ts'],
          validation_commands: ['pnpm test -- src/proof.test.ts'],
        },
      ],
    };

    const revalidationPayload = {
      validationRunId: 'validation-1',
      passed: false,
      failedCommands: ['! pnpm test -- src/proof.test.ts'],
    } as RevalidationResult;

    const harness = createHarness({
      manifest: mixedManifest,
      changedFiles: [
        'src/proof.test.ts',
        'src/future-fix.ts',
        'src/drift.ts',
        'src/non-goal.ts',
        '.gitignore',
        'generated/allowed.ts',
      ],
      revalidationResult: revalidationPayload,
    });

    const result: ImplementStepLoopResult = await harness.loop.execute(harness.input);

    expect(result.outcome).toBe('recoverable_scope_violation');
    expect(result.loop.status).toBe('failed');
    expect(result.loop.iterations).toHaveLength(1);
    expect(result.loop.iterations[0].outcome).toBe('failed');
    expect(result.loop.iterations[0].reviewInvocationId).toBe('');
    expect(result.prematureImplementation).toEqual([{ path: 'src/future-fix.ts', taskNumber: 2 }]);
    expect(result.driftFiles).toEqual(['src/drift.ts']);
    expect(result.nonGoalFiles).toEqual(['src/non-goal.ts']);
    expect(result.protectedFiles).toEqual(['.gitignore']);

    expect(result.failureMessage).toBeDefined();
    expect(result.failureMessage).toContain('Task 1');
    expect(result.failureMessage).toContain('src/future-fix.ts (owned by task 2)');
    expect(result.failureMessage).toContain('src/drift.ts');

    const redEvent = harness.events.find((e) => e.type === 'step.red_first_violation');
    expect(redEvent).toBeDefined();
    expect(redEvent?.metadata).toMatchObject({
      prematureImplementation: [{ path: 'src/future-fix.ts', taskNumber: 2 }],
      driftFiles: ['src/drift.ts'],
      nonGoalFiles: ['src/non-goal.ts'],
      protectedFiles: ['.gitignore'],
      failedInvertedCommands: ['! pnpm test -- src/proof.test.ts'],
    });

    expect(harness.runSpecReview).not.toHaveBeenCalled();
    expect(harness.runQualityReview).not.toHaveBeenCalled();
    expect(harness.runFix).not.toHaveBeenCalled();
  });

  it('allows a RED-first task to survive review-fix iterations when revalidation passes', async () => {
    const harness = createHarness({
      manifest: baseManifest,
      initialPreStepHead: 'before-step',
      changedFiles: ['src/proof.test.ts'],
      createdFiles: ['src/proof.test.ts'],
      revalidationResult: {
        validationRunId: 'val-excused-red',
        passed: true,
      },
    });
    harness.input.maxIterations = 5;

    let specCount = 0;
    harness.runSpecReview.mockImplementation(async () => {
      specCount++;
      if (specCount === 1) {
        return {
          invocationId: 'spec-1',
          agentOutcome: 'success',
          verdict: 'fail',
          findings: [{ severity: 'P2', summary: 'Minor spec issue in proof comment' }],
          snapshot: { snapshot: 'spec-snap-1' },
        };
      }
      return {
        invocationId: 'spec-2',
        agentOutcome: 'success',
        verdict: 'pass',
        snapshot: { snapshot: 'spec-snap-2' },
      };
    });

    harness.runFix.mockImplementation(async () => {
      harness.git.headByCwd.set('/wt', 'after-fix');
      harness.git.changedFilesResults.set('before-step|after-fix', ['src/proof.test.ts']);
      harness.git.createdFilesResults.set('before-step|after-fix', ['src/proof.test.ts']);
      return {
        invocationId: 'fix-1',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
        headBeforeFix: 'after-implement',
      };
    });

    const result: ImplementStepLoopResult = await harness.loop.execute(harness.input);

    expect(result.outcome).toBe('success');
    expect(result.loop.status).toBe('converged');
    expect(harness.runRevalidation).toHaveBeenCalled();
  });
});
