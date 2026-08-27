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
import {
  MAX_TERMINAL_FIX_CHANGED_LINES,
  TERMINAL_FIX_SCOPE_POLICY,
} from '../terminal-fix-scope-policy.js';

interface HarnessOptions {
  manifest?: TaskManifest;
  changedFiles?: string[];
  headSha?: string;
  stepIndex?: number;
  stepTitle?: string;
  revalidationResult?: RevalidationResult;
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

  const runSpecReview = vi.fn(
    async (
      _ctx: StepLoopContext,
      _tcResult: TypecheckResult,
      _scope: ReviewScopeOptions,
    ): Promise<SpecReviewResult> => ({
      invocationId: 'spec-1',
      agentOutcome: 'success',
      verdict: 'pass',
      snapshot: { snapshot: 'spec-snap-1' },
    }),
  );

  const runQualityReview = vi.fn(
    async (
      _ctx: StepLoopContext,
      _tcResult: TypecheckResult,
      _scope: ReviewScopeOptions,
    ): Promise<QualityReviewResult> => ({
      invocationId: 'qual-1',
      agentOutcome: 'success',
      verdict: 'pass',
      snapshot: { snapshot: 'quality-snap-1' },
    }),
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
    terminalFixProfile: AgentProfileName('terminal-fix-profile'),
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
        title: 'Task 1: Core implementation',
        expected_files: ['src/feature.ts'],
      },
    ],
  };

  const input = {
    runId: RunId('run-1'),
    phaseId: PhaseName('implement'),
    repoId: 'acme/widgets',
    cwd: '/wt',
    stepIndex: options.stepIndex ?? 1,
    stepTitle: options.stepTitle ?? 'Task 1: Core implementation',
    maxIterations: 1,
    manifest: options.manifest ?? defaultManifest,
    planMd: '# Plan\n\n## Task 1: Core implementation\n',
    initialPreStepHead: 'head-0',
  };

  return {
    harness: {
      deps,
      git,
      loop,
      input,
      events,
      runSpecReview,
      runQualityReview,
      runFix,
      runImplement,
      runTypecheck,
      runRevalidation,
    },
  };
}

describe('implement-step terminal-fix auto-extension behavioral invariants', () => {
  it('terminal fix auto-extends one unowned narrow modification and records invocation evidence', async () => {
    const { harness } = createHarness();

    // Spec review fails to exhaust loop and trigger terminal fix
    harness.runSpecReview.mockImplementation(async () => ({
      invocationId: 'spec-fail',
      agentOutcome: 'success',
      verdict: 'fail',
      findings: [{ severity: 'high', summary: 'Defect' }],
    }));

    harness.runFix.mockImplementation(async (_ctx, opts) => {
      if (opts.isTerminalFix) {
        harness.git.headByCwd.set('/wt', 'head-term');
        harness.git.changedFilesResults.set('head-0|head-term', [
          'src/feature.ts',
          'lib/unowned-helper.ts',
        ]);
        harness.git.fileChangeSummaryResults.set('head-0|head-term', [
          {
            path: 'lib/unowned-helper.ts',
            additions: 2,
            deletions: 1,
            status: 'modified',
            binary: false,
          },
          {
            path: 'src/feature.ts',
            additions: 5,
            deletions: 0,
            status: 'modified',
            binary: false,
          },
        ]);
        return {
          invocationId: 'fix-term-1',
          agentOutcome: 'success',
          verdict: 'done_with_fixes',
          headBeforeFix: 'head-0',
        };
      }
      return {
        invocationId: 'fix-regular',
        agentOutcome: 'success',
        verdict: 'cannot_fix',
      };
    });

    const result = await harness.loop.execute(harness.input);

    expect(result.outcome).toBe('success');

    // Scope auto-extended event emitted at warn level before acceptance
    const autoExtendEvent = harness.events.find(
      (e) => e.type === 'step.terminal_fix.scope_auto_extended',
    );
    expect(autoExtendEvent).toBeDefined();
    expect(autoExtendEvent?.level).toBe('warn');
    expect(autoExtendEvent?.metadata.invocationId).toBe('fix-term-1');
    expect(autoExtendEvent?.metadata.stepIndex).toBe(1);
    expect(autoExtendEvent?.metadata.headBeforeFix).toBe('head-0');
    expect(autoExtendEvent?.metadata.headAfterFix).toBe('head-term');
    expect(autoExtendEvent?.metadata.range).toBe('head-0..head-term');
    expect(autoExtendEvent?.metadata.grantedFiles).toEqual(['lib/unowned-helper.ts']);
    expect(autoExtendEvent?.metadata.policy).toBe(TERMINAL_FIX_SCOPE_POLICY);
    expect(autoExtendEvent?.metadata.threshold).toBe(MAX_TERMINAL_FIX_CHANGED_LINES);

    // Terminal fix accepted event enriched with autoExtendedFiles and invocationId
    const acceptedEvent = harness.events.find((e) => e.type === 'step.terminal_fix.accepted');
    expect(acceptedEvent).toBeDefined();
    expect(acceptedEvent?.metadata.invocationId).toBe('fix-term-1');
    expect(acceptedEvent?.metadata.autoExtendedFiles).toEqual(['lib/unowned-helper.ts']);
  });

  it('terminal fix rejects an atomic mix of one eligible drift file and another tasks non-goal', async () => {
    const manifest: TaskManifest = {
      version: 2,
      task_count: 2,
      tasks: [
        {
          n: 1,
          title: 'Task 1: Core implementation',
          expected_files: ['src/task1/feature.ts'],
        },
        {
          n: 2,
          title: 'Task 2: Other task',
          expected_files: ['src/task2/task2.ts'],
          non_goals: ['src/legacy/'],
        },
      ],
    };

    const { harness } = createHarness({ manifest });

    harness.runSpecReview.mockImplementation(async () => ({
      invocationId: 'spec-fail',
      agentOutcome: 'success',
      verdict: 'fail',
      findings: [{ severity: 'high', summary: 'Defect' }],
    }));

    harness.runFix.mockImplementation(async (_ctx, opts) => {
      if (opts.isTerminalFix) {
        harness.git.headByCwd.set('/wt', 'head-term');
        harness.git.changedFilesResults.set('head-0|head-term', [
          'src/task1/feature.ts',
          'lib/unowned-helper.ts',
          'src/legacy/old.ts',
        ]);
        harness.git.fileChangeSummaryResults.set('head-0|head-term', [
          {
            path: 'lib/unowned-helper.ts',
            additions: 1,
            deletions: 0,
            status: 'modified',
            binary: false,
          },
          {
            path: 'src/legacy/old.ts',
            additions: 1,
            deletions: 0,
            status: 'modified',
            binary: false,
          },
          {
            path: 'src/task1/feature.ts',
            additions: 1,
            deletions: 0,
            status: 'modified',
            binary: false,
          },
        ]);
        return {
          invocationId: 'fix-term-mix',
          agentOutcome: 'success',
          verdict: 'done_with_fixes',
          headBeforeFix: 'head-0',
        };
      }
      return {
        invocationId: 'fix-regular',
        agentOutcome: 'success',
        verdict: 'cannot_fix',
      };
    });

    const result = await harness.loop.execute(harness.input);

    expect(result.outcome).toBe('needs_human_review');
    expect(
      harness.events.find((e) => e.type === 'step.terminal_fix.scope_auto_extended'),
    ).toBeUndefined();

    const rejectedEvent = harness.events.find((e) => e.type === 'step.terminal_fix.rejected');
    expect(rejectedEvent).toBeDefined();
    expect(rejectedEvent?.metadata.rejectionReason).toBe('manifest_stake');
  });

  it('terminal fix rejects earlier and later expected or reference ownership', async () => {
    const manifest: TaskManifest = {
      version: 2,
      task_count: 3,
      tasks: [
        {
          n: 1,
          title: 'Task 1: Earlier task',
          expected_files: ['src/task1/expected.ts'],
          reference_files: ['src/task1/ref.ts'],
        },
        {
          n: 2,
          title: 'Task 2: Current task',
          expected_files: ['src/task2/current.ts'],
        },
        {
          n: 3,
          title: 'Task 3: Later task',
          expected_files: ['src/task3/expected.ts'],
          reference_files: ['src/task3/ref.ts'],
        },
      ],
    };

    const ownedFilesToTest = [
      'src/task1/expected.ts',
      'src/task1/ref.ts',
      'src/task3/expected.ts',
      'src/task3/ref.ts',
    ];

    for (const ownedFile of ownedFilesToTest) {
      const { harness } = createHarness({
        manifest,
        stepIndex: 2,
        stepTitle: 'Task 2: Current task',
      });

      harness.runSpecReview.mockImplementation(async () => ({
        invocationId: 'spec-fail',
        agentOutcome: 'success',
        verdict: 'fail',
        findings: [{ severity: 'high', summary: 'Defect' }],
      }));

      harness.runFix.mockImplementation(async (_ctx, opts) => {
        if (opts.isTerminalFix) {
          harness.git.headByCwd.set('/wt', 'head-term');
          harness.git.changedFilesResults.set('head-0|head-term', [
            'src/task2/current.ts',
            ownedFile,
          ]);
          harness.git.fileChangeSummaryResults.set('head-0|head-term', [
            {
              path: 'src/task2/current.ts',
              additions: 1,
              deletions: 0,
              status: 'modified',
              binary: false,
            },
            {
              path: ownedFile,
              additions: 1,
              deletions: 0,
              status: 'modified',
              binary: false,
            },
          ]);
          return {
            invocationId: `fix-term-${ownedFile}`,
            agentOutcome: 'success',
            verdict: 'done_with_fixes',
            headBeforeFix: 'head-0',
          };
        }
        return {
          invocationId: 'fix-regular',
          agentOutcome: 'success',
          verdict: 'cannot_fix',
        };
      });

      const result = await harness.loop.execute(harness.input);

      expect(result.outcome).toBe('needs_human_review');
      expect(
        harness.events.find((e) => e.type === 'step.terminal_fix.scope_auto_extended'),
      ).toBeUndefined();
      expect(harness.events.find((e) => e.type === 'step.terminal_fix.rejected')).toBeDefined();
    }
  });

  it('terminal fix rejects current-task non-goals protected files and structural or eleven-line changes', async () => {
    const manifest: TaskManifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1: Current task',
          expected_files: ['src/feature.ts'],
          non_goals: ['src/forbidden/'],
        },
      ],
    };

    const scenarios = [
      {
        name: 'current-task non-goal',
        file: 'src/forbidden/blocked.ts',
        summary: {
          path: 'src/forbidden/blocked.ts',
          additions: 1,
          deletions: 0,
          status: 'modified' as const,
          binary: false,
        },
      },
      {
        name: 'protected file',
        file: '.ai-orchestrator.json',
        summary: {
          path: '.ai-orchestrator.json',
          additions: 1,
          deletions: 0,
          status: 'modified' as const,
          binary: false,
        },
      },
      {
        name: 'structural addition',
        file: 'lib/unowned-added.ts',
        summary: {
          path: 'lib/unowned-added.ts',
          additions: 1,
          deletions: 0,
          status: 'added' as const,
          binary: false,
        },
      },
      {
        name: 'structural deletion',
        file: 'lib/unowned-deleted.ts',
        summary: {
          path: 'lib/unowned-deleted.ts',
          additions: 0,
          deletions: 1,
          status: 'deleted' as const,
          binary: false,
        },
      },
      {
        name: 'binary change',
        file: 'lib/unowned-bin.bin',
        summary: {
          path: 'lib/unowned-bin.bin',
          additions: 1,
          deletions: 0,
          status: 'modified' as const,
          binary: true,
        },
      },
      {
        name: 'eleven lines changed',
        file: 'lib/unowned-large.ts',
        summary: {
          path: 'lib/unowned-large.ts',
          additions: 6,
          deletions: 5,
          status: 'modified' as const,
          binary: false,
        },
      },
    ];

    for (const scenario of scenarios) {
      const { harness } = createHarness({ manifest });

      harness.runSpecReview.mockImplementation(async () => ({
        invocationId: 'spec-fail',
        agentOutcome: 'success',
        verdict: 'fail',
        findings: [{ severity: 'high', summary: 'Defect' }],
      }));

      harness.runFix.mockImplementation(async (_ctx, opts) => {
        if (opts.isTerminalFix) {
          harness.git.headByCwd.set('/wt', 'head-term');
          harness.git.changedFilesResults.set('head-0|head-term', [
            'src/feature.ts',
            scenario.file,
          ]);
          harness.git.fileChangeSummaryResults.set('head-0|head-term', [
            {
              path: 'src/feature.ts',
              additions: 1,
              deletions: 0,
              status: 'modified',
              binary: false,
            },
            scenario.summary,
          ]);
          return {
            invocationId: `fix-term-${scenario.name}`,
            agentOutcome: 'success',
            verdict: 'done_with_fixes',
            headBeforeFix: 'head-0',
          };
        }
        return {
          invocationId: 'fix-regular',
          agentOutcome: 'success',
          verdict: 'cannot_fix',
        };
      });

      const result = await harness.loop.execute(harness.input);

      expect(result.outcome).toBe('needs_human_review');
      expect(
        harness.events.find((e) => e.type === 'step.terminal_fix.scope_auto_extended'),
      ).toBeUndefined();
      expect(harness.events.find((e) => e.type === 'step.terminal_fix.rejected')).toBeDefined();
    }
  });

  it('terminal fix rejects unavailable failing missing or ambiguous change-summary inspection', async () => {
    // 1. Unavailable method
    {
      const { harness } = createHarness();
      delete (harness.git as Partial<FakeGitPort>).fileChangeSummary;

      harness.runSpecReview.mockImplementation(async () => ({
        invocationId: 'spec-fail',
        agentOutcome: 'success',
        verdict: 'fail',
        findings: [{ severity: 'high', summary: 'Defect' }],
      }));

      harness.runFix.mockImplementation(async (_ctx, opts) => {
        if (opts.isTerminalFix) {
          harness.git.headByCwd.set('/wt', 'head-term');
          harness.git.changedFilesResults.set('head-0|head-term', [
            'src/feature.ts',
            'lib/unowned.ts',
          ]);
          return {
            invocationId: 'fix-term-no-method',
            agentOutcome: 'success',
            verdict: 'done_with_fixes',
            headBeforeFix: 'head-0',
          };
        }
        return {
          invocationId: 'fix-regular',
          agentOutcome: 'success',
          verdict: 'cannot_fix',
        };
      });

      const result = await harness.loop.execute(harness.input);
      expect(result.outcome).toBe('needs_human_review');
      expect(
        harness.events.find((e) => e.type === 'step.terminal_fix.scope_auto_extended'),
      ).toBeUndefined();
    }

    // 2. Throwing inspection
    {
      const { harness } = createHarness();
      harness.git.fileChangeSummary = vi.fn().mockRejectedValue(new Error('git diff failed'));

      harness.runSpecReview.mockImplementation(async () => ({
        invocationId: 'spec-fail',
        agentOutcome: 'success',
        verdict: 'fail',
        findings: [{ severity: 'high', summary: 'Defect' }],
      }));

      harness.runFix.mockImplementation(async (_ctx, opts) => {
        if (opts.isTerminalFix) {
          harness.git.headByCwd.set('/wt', 'head-term');
          harness.git.changedFilesResults.set('head-0|head-term', [
            'src/feature.ts',
            'lib/unowned.ts',
          ]);
          return {
            invocationId: 'fix-term-throw',
            agentOutcome: 'success',
            verdict: 'done_with_fixes',
            headBeforeFix: 'head-0',
          };
        }
        return {
          invocationId: 'fix-regular',
          agentOutcome: 'success',
          verdict: 'cannot_fix',
        };
      });

      const result = await harness.loop.execute(harness.input);
      expect(result.outcome).toBe('needs_human_review');
      expect(
        harness.events.find((e) => e.type === 'step.terminal_fix.scope_auto_extended'),
      ).toBeUndefined();
    }

    // 3. Missing summary
    {
      const { harness } = createHarness();
      harness.git.fileChangeSummaryResults.set('head-0|head-term', []); // empty

      harness.runSpecReview.mockImplementation(async () => ({
        invocationId: 'spec-fail',
        agentOutcome: 'success',
        verdict: 'fail',
        findings: [{ severity: 'high', summary: 'Defect' }],
      }));

      harness.runFix.mockImplementation(async (_ctx, opts) => {
        if (opts.isTerminalFix) {
          harness.git.headByCwd.set('/wt', 'head-term');
          harness.git.changedFilesResults.set('head-0|head-term', [
            'src/feature.ts',
            'lib/unowned.ts',
          ]);
          return {
            invocationId: 'fix-term-missing',
            agentOutcome: 'success',
            verdict: 'done_with_fixes',
            headBeforeFix: 'head-0',
          };
        }
        return {
          invocationId: 'fix-regular',
          agentOutcome: 'success',
          verdict: 'cannot_fix',
        };
      });

      const result = await harness.loop.execute(harness.input);
      expect(result.outcome).toBe('needs_human_review');
      expect(
        harness.events.find((e) => e.type === 'step.terminal_fix.scope_auto_extended'),
      ).toBeUndefined();
    }

    // 4. Ambiguous summary (multiple entries for same file)
    {
      const { harness } = createHarness();
      harness.git.fileChangeSummaryResults.set('head-0|head-term', [
        {
          path: 'lib/unowned.ts',
          additions: 1,
          deletions: 0,
          status: 'modified',
          binary: false,
        },
        {
          path: 'lib/unowned.ts',
          additions: 2,
          deletions: 0,
          status: 'modified',
          binary: false,
        },
      ]);

      harness.runSpecReview.mockImplementation(async () => ({
        invocationId: 'spec-fail',
        agentOutcome: 'success',
        verdict: 'fail',
        findings: [{ severity: 'high', summary: 'Defect' }],
      }));

      harness.runFix.mockImplementation(async (_ctx, opts) => {
        if (opts.isTerminalFix) {
          harness.git.headByCwd.set('/wt', 'head-term');
          harness.git.changedFilesResults.set('head-0|head-term', [
            'src/feature.ts',
            'lib/unowned.ts',
          ]);
          return {
            invocationId: 'fix-term-ambiguous',
            agentOutcome: 'success',
            verdict: 'done_with_fixes',
            headBeforeFix: 'head-0',
          };
        }
        return {
          invocationId: 'fix-regular',
          agentOutcome: 'success',
          verdict: 'cannot_fix',
        };
      });

      const result = await harness.loop.execute(harness.input);
      expect(result.outcome).toBe('needs_human_review');
      expect(
        harness.events.find((e) => e.type === 'step.terminal_fix.scope_auto_extended'),
      ).toBeUndefined();
    }
  });

  it('terminal fix overlay does not mutate the input manifest and does not survive the invocation', async () => {
    const manifest: TaskManifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1: Core implementation',
          expected_files: ['src/feature.ts'],
        },
      ],
    };

    const snapshotBefore = JSON.parse(JSON.stringify(manifest));
    const { harness } = createHarness({ manifest });

    harness.runSpecReview.mockImplementation(async () => ({
      invocationId: 'spec-fail',
      agentOutcome: 'success',
      verdict: 'fail',
      findings: [{ severity: 'high', summary: 'Defect' }],
    }));

    harness.runFix.mockImplementation(async (_ctx, opts) => {
      if (opts.isTerminalFix) {
        harness.git.headByCwd.set('/wt', 'head-term');
        harness.git.changedFilesResults.set('head-0|head-term', [
          'src/feature.ts',
          'lib/unowned-helper.ts',
        ]);
        harness.git.fileChangeSummaryResults.set('head-0|head-term', [
          {
            path: 'lib/unowned-helper.ts',
            additions: 1,
            deletions: 0,
            status: 'modified',
            binary: false,
          },
          {
            path: 'src/feature.ts',
            additions: 1,
            deletions: 0,
            status: 'modified',
            binary: false,
          },
        ]);
        return {
          invocationId: 'fix-term-1',
          agentOutcome: 'success',
          verdict: 'done_with_fixes',
          headBeforeFix: 'head-0',
        };
      }
      return {
        invocationId: 'fix-regular',
        agentOutcome: 'success',
        verdict: 'cannot_fix',
      };
    });

    const result = await harness.loop.execute(harness.input);
    expect(result.outcome).toBe('success');

    // Verify input manifest was not mutated
    expect(harness.input.manifest).toEqual(snapshotBefore);
  });

  it('ordinary fix-review keeps rejecting an unowned one-line drift without requesting summaries', async () => {
    const { harness } = createHarness();

    // Spec review fails to trigger fix
    harness.runSpecReview.mockImplementation(async () => ({
      invocationId: 'spec-fail',
      agentOutcome: 'success',
      verdict: 'fail',
      findings: [{ severity: 'high', summary: 'Defect' }],
    }));

    harness.runFix.mockImplementation(async (_ctx, opts) => {
      if (!opts.isTerminalFix) {
        harness.git.headByCwd.set('/wt', 'head-regular');
        harness.git.changedFilesResults.set('after-implement|head-regular', [
          'src/feature.ts',
          'lib/unowned-helper.ts',
        ]);
        return {
          invocationId: 'fix-reg-1',
          agentOutcome: 'success',
          verdict: 'done_with_fixes',
          headBeforeFix: 'after-implement',
        };
      }
      return {
        invocationId: 'fix-term',
        agentOutcome: 'success',
        verdict: 'cannot_fix',
      };
    });

    await harness.loop.execute({ ...harness.input, maxIterations: 2 });

    // Ordinary fix-review boundary check must not call fileChangeSummary
    expect(harness.git.fileChangeSummaryCalls.length).toBe(0);

    // task_boundary.violated was emitted
    const violatedEvent = harness.events.find((e) => e.type === 'task_boundary.violated');
    expect(violatedEvent).toBeDefined();
  });

  it('terminal fix still runs typecheck and revalidation after scope authorization', async () => {
    // 1. Typecheck failure after scope auto-extension
    {
      const { harness } = createHarness();

      harness.runSpecReview.mockImplementation(async () => ({
        invocationId: 'spec-fail',
        agentOutcome: 'success',
        verdict: 'fail',
        findings: [{ severity: 'high', summary: 'Defect' }],
      }));

      harness.runFix.mockImplementation(async (_ctx, opts) => {
        if (opts.isTerminalFix) {
          harness.git.headByCwd.set('/wt', 'head-term');
          harness.git.changedFilesResults.set('head-0|head-term', [
            'src/feature.ts',
            'lib/unowned-helper.ts',
          ]);
          harness.git.fileChangeSummaryResults.set('head-0|head-term', [
            {
              path: 'lib/unowned-helper.ts',
              additions: 1,
              deletions: 0,
              status: 'modified',
              binary: false,
            },
            {
              path: 'src/feature.ts',
              additions: 1,
              deletions: 0,
              status: 'modified',
              binary: false,
            },
          ]);
          return {
            invocationId: 'fix-term-tc-fail',
            agentOutcome: 'success',
            verdict: 'done_with_fixes',
            headBeforeFix: 'head-0',
          };
        }
        return {
          invocationId: 'fix-regular',
          agentOutcome: 'success',
          verdict: 'cannot_fix',
        };
      });

      // Pass initial typecheck, fail post-fix typecheck
      let tcCallCount = 0;
      harness.runTypecheck.mockImplementation(async () => {
        tcCallCount++;
        if (tcCallCount >= 2) {
          return { outcome: 'fail', output: 'Type error in helper' };
        }
        return { outcome: 'pass', output: '' };
      });

      const result = await harness.loop.execute(harness.input);
      expect(result.outcome).toBe('needs_human_review');

      // Scope was authorized...
      expect(
        harness.events.find((e) => e.type === 'step.terminal_fix.scope_auto_extended'),
      ).toBeDefined();

      // ...but accepted was not emitted due to deterministic failure
      expect(harness.events.find((e) => e.type === 'step.terminal_fix.accepted')).toBeUndefined();

      const rejectedEvent = harness.events.find((e) => e.type === 'step.terminal_fix.rejected');
      expect(rejectedEvent).toBeDefined();
      expect(rejectedEvent?.metadata.typecheckOutcome).toBe('fail');
    }

    // 2. Revalidation failure after scope auto-extension
    {
      const { harness } = createHarness({
        revalidationResult: {
          validationRunId: 'v-fail',
          passed: false,
          failureDetail: 'Test failed',
        },
      });

      harness.runSpecReview.mockImplementation(async () => ({
        invocationId: 'spec-fail',
        agentOutcome: 'success',
        verdict: 'fail',
        findings: [{ severity: 'high', summary: 'Defect' }],
      }));

      harness.runFix.mockImplementation(async (_ctx, opts) => {
        if (opts.isTerminalFix) {
          harness.git.headByCwd.set('/wt', 'head-term');
          harness.git.changedFilesResults.set('head-0|head-term', [
            'src/feature.ts',
            'lib/unowned-helper.ts',
          ]);
          harness.git.fileChangeSummaryResults.set('head-0|head-term', [
            {
              path: 'lib/unowned-helper.ts',
              additions: 1,
              deletions: 0,
              status: 'modified',
              binary: false,
            },
            {
              path: 'src/feature.ts',
              additions: 1,
              deletions: 0,
              status: 'modified',
              binary: false,
            },
          ]);
          return {
            invocationId: 'fix-term-reval-fail',
            agentOutcome: 'success',
            verdict: 'done_with_fixes',
            headBeforeFix: 'head-0',
          };
        }
        return {
          invocationId: 'fix-regular',
          agentOutcome: 'success',
          verdict: 'cannot_fix',
        };
      });

      const result = await harness.loop.execute(harness.input);
      expect(result.outcome).toBe('needs_human_review');

      // Scope was authorized...
      expect(
        harness.events.find((e) => e.type === 'step.terminal_fix.scope_auto_extended'),
      ).toBeDefined();

      // ...but accepted was not emitted due to revalidation failure
      expect(harness.events.find((e) => e.type === 'step.terminal_fix.accepted')).toBeUndefined();

      const rejectedEvent = harness.events.find((e) => e.type === 'step.terminal_fix.rejected');
      expect(rejectedEvent).toBeDefined();
      expect(rejectedEvent?.metadata.revalidationPassed).toBe(false);
    }
  });
});
