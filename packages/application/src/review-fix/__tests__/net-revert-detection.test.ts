import { describe, it, expect, vi } from 'vitest';
import { RunId, PhaseName, AgentProfileName } from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import type { EventBusPort } from '../../ports/event-bus-port.js';
import type { FindingEvidenceInspectorPort } from '../../ports/finding-evidence-inspector-port.js';
import type { ArtifactStore } from '../../ports.js';
import { FakeGitPort } from '../../test-doubles/fake-git-port.js';
import { FakeLoopRepository } from '../../test-doubles/fake-loop-repository.js';
import {
  FakeFindingEvidenceInspector,
  makeFindingEvidenceInspector,
} from '../../test-doubles/fake-finding-evidence-inspector.js';
import { FakeArtifactStore } from '../../test-doubles/fake-artifact-store.js';
import { ReviewFixLoop } from '../review-fix-loop.js';
import type {
  ReviewFixLoopDeps,
  ReviewFixLoopInput,
  ReviewStepResult,
  FixStepResult,
  RevalidationResult,
  FixStepOptions,
  StepContext,
  ReviewStepOptions,
} from '../types.js';

function inputWithBaseline(overrides?: Partial<ReviewFixLoopInput>): ReviewFixLoopInput {
  return {
    runId: RunId('run-net-revert'),
    phaseId: PhaseName('review-fix'),
    repoId: 'owner/repo',
    cwd: '/worktree',
    maxIterations: 2,
    reviewProfile: AgentProfileName('review'),
    fixProfile: AgentProfileName('fix'),
    baselineCommitSha: 'run-start-sha',
    ...overrides,
  };
}

function collectEvents() {
  const events: Array<{ type: string; metadata: Record<string, unknown> }> = [];
  const bus: EventBusPort = {
    publish: (_runUuid: string, e: OrchestratorEvent) =>
      events.push({ type: e.type, metadata: (e.metadata ?? {}) as Record<string, unknown> }),
    subscribe: () => () => {},
  };
  return { events, bus };
}

interface HarnessOptions {
  initialChangedFiles?: string[];
  finalChangedFiles?: string[];
  initialChangedFilesError?: Error;
  finalChangedFilesError?: Error;
  onChangedFiles?: () => void;
  onReview?: () => void;
  runReview?: (ctx: StepContext, opts?: ReviewStepOptions) => Promise<ReviewStepResult>;
  runFix?: (ctx: StepContext, opts: FixStepOptions) => Promise<FixStepResult>;
  runRevalidation?: (ctx: StepContext) => Promise<RevalidationResult>;
  findingEvidenceInspector?: FindingEvidenceInspectorPort;
  artifactStore?: ArtifactStore;
  runArbiter?: ReviewFixLoopDeps['runArbiter'];
  options?: ReviewFixLoopDeps['options'];
}

function makeHarness(options: HarnessOptions = {}) {
  const { events, bus } = collectEvents();
  const git = new FakeGitPort();
  git.headByCwd.set('/worktree', 'run-start-sha');

  let changedFilesCount = 0;
  vi.spyOn(git, 'changedFiles').mockImplementation(async (_cwd, _base, _head) => {
    options.onChangedFiles?.();
    changedFilesCount++;
    if (changedFilesCount === 1) {
      if (options.initialChangedFilesError) throw options.initialChangedFilesError;
      return options.initialChangedFiles ?? [];
    }
    if (options.finalChangedFilesError) throw options.finalChangedFilesError;
    return options.finalChangedFiles ?? [];
  });

  let reviewCount = 0;
  const defaultRunReview = async (
    _ctx: StepContext,
    _opts?: ReviewStepOptions,
  ): Promise<ReviewStepResult> => {
    reviewCount++;
    if (reviewCount === 1) {
      return {
        invocationId: 'rev-1',
        agentOutcome: 'success',
        verdict: 'fail',
        offendingFindings: [{ severity: 'error', summary: 'finding 1' }],
      };
    }
    return {
      invocationId: 'rev-2',
      agentOutcome: 'success',
      verdict: 'pass',
    };
  };

  const runReview = async (
    ctx: StepContext,
    opts?: ReviewStepOptions,
  ): Promise<ReviewStepResult> => {
    options.onReview?.();
    if (options.runReview) {
      return options.runReview(ctx, opts);
    }
    return defaultRunReview(ctx, opts);
  };

  let fixCount = 0;
  const defaultRunFix = async (ctx: StepContext, _opts: FixStepOptions): Promise<FixStepResult> => {
    fixCount++;
    await git.commit(ctx.cwd, `fix ${fixCount}`);
    return {
      invocationId: `fix-${fixCount}`,
      agentOutcome: 'success',
      verdict: 'done_with_fixes',
    };
  };

  const runFix = options.runFix ?? defaultRunFix;
  const runRevalidation =
    options.runRevalidation ?? (async () => ({ validationRunId: 'val-1', passed: true }));

  const loops = new FakeLoopRepository();
  let idCount = 0;

  const historyEntries: import('../types.js').ReviewLoopHistoryEntry[] = [];
  const loopHistory: ReviewFixLoopDeps['loopHistory'] = {
    async read() {
      return historyEntries;
    },
    async append(_ctx, entry) {
      historyEntries.push(entry);
    },
    format() {
      return '';
    },
  };

  const deps: ReviewFixLoopDeps = {
    runPostFixGate: async () => ({ outcome: 'pass', output: '' }),
    runReview,
    runFix,
    runRevalidation,
    loops,
    events: bus,
    now: () => new Date('2026-01-01T00:00:00Z'),
    idFactory: () => `loop-${++idCount}`,
    git,
    loopHistory,
    findingEvidenceInspector: options.findingEvidenceInspector,
    artifactStore: options.artifactStore,
    runArbiter: options.runArbiter,
    options: options.options,
  };

  const loop = new ReviewFixLoop(deps);

  return { loop, events, git, deps, loops };
}

describe('ReviewFixLoop net-revert detection', () => {
  it('escalates when review-fix restores an initially changed file to the run baseline', async () => {
    const harness = makeHarness({
      initialChangedFiles: ['src/fix.ts', 'src/fix.test.ts'],
      finalChangedFiles: ['src/fix.test.ts'],
    });

    const result = await harness.loop.execute(inputWithBaseline());

    expect(result).toMatchObject({
      phaseOutcome: 'failed',
      loopStatus: 'failed',
      needsHumanReview: true,
    });
    expect(result.loop.status).toBe('failed');
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        type: 'review_fix.net_revert_detected',
        metadata: expect.objectContaining({ revertedFiles: ['src/fix.ts'] }),
      }),
    );
  });

  it('captures target files before the first review invocation', async () => {
    const order: string[] = [];
    const harness = makeHarness({
      initialChangedFiles: ['src/fix.ts'],
      finalChangedFiles: ['src/fix.ts'],
      onChangedFiles: () => order.push('changed-files'),
      onReview: () => order.push('review'),
    });
    await harness.loop.execute(inputWithBaseline());
    expect(order.slice(0, 2)).toEqual(['changed-files', 'review']);
  });

  it('preserves convergence when every initial path remains changed', async () => {
    const harness = makeHarness({
      initialChangedFiles: ['src/fix.ts'],
      finalChangedFiles: ['src/fix.ts', 'src/refinement.ts'],
    });
    const result = await harness.loop.execute(inputWithBaseline());
    expect(result).toMatchObject({ phaseOutcome: 'passed', loopStatus: 'converged' });
  });

  it('fails closed when the final baseline comparison cannot be completed', async () => {
    const harness = makeHarness({
      initialChangedFiles: ['src/fix.ts'],
      finalChangedFilesError: new Error('git diff failed'),
    });
    const result = await harness.loop.execute(inputWithBaseline());
    expect(result).toMatchObject({ phaseOutcome: 'failed', needsHumanReview: true });
    expect(
      harness.events.some((event) => event.type === 'review_fix.net_revert_check_failed'),
    ).toBe(true);
  });

  it('fails closed when the initial target snapshot cannot be captured', async () => {
    const harness = makeHarness({ initialChangedFilesError: new Error('git diff failed') });
    const result = await harness.loop.execute(inputWithBaseline());
    expect(result).toMatchObject({ phaseOutcome: 'failed', needsHumanReview: true });
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        type: 'review_fix.net_revert_check_failed',
        metadata: expect.objectContaining({ stage: 'capture' }),
      }),
    );
  });

  it('does not blame review-fix when no files were changed at loop entry', async () => {
    const harness = makeHarness({ initialChangedFiles: [], finalChangedFiles: [] });
    const result = await harness.loop.execute(inputWithBaseline());
    expect(result).toMatchObject({ phaseOutcome: 'passed', loopStatus: 'converged' });
  });

  it('preserves legacy behavior when no run baseline is supplied', async () => {
    const harness = makeHarness({
      initialChangedFiles: ['src/fix.ts'],
      finalChangedFiles: [],
    });
    const { baselineCommitSha: _baseline, ...legacyInput } = inputWithBaseline();
    const result = await harness.loop.execute(legacyInput);
    expect(result).toMatchObject({ phaseOutcome: 'passed', loopStatus: 'converged' });
    expect(harness.git.changedFiles).not.toHaveBeenCalled();
  });

  it('escalates every otherwise-successful exit when an initial path returns to baseline', async () => {
    const evidenceFake = new FakeFindingEvidenceInspector();
    evidenceFake.setNext({ evidenceConfirmed: false, reason: 'unfounded' });
    const findingEvidenceInspector = makeFindingEvidenceInspector(evidenceFake);
    const artifactStore = new FakeArtifactStore();

    let trendReviewCount = 0;

    const cases: Array<{
      name: string;
      harnessOpts: HarnessOptions;
      input?: ReviewFixLoopInput;
    }> = [
      {
        name: 'normal review-pass convergence',
        harnessOpts: {},
      },
      {
        name: 'accepted rebuttal',
        harnessOpts: {
          findingEvidenceInspector,
          artifactStore,
          runReview: async () => ({
            invocationId: 'rev-1',
            agentOutcome: 'success',
            verdict: 'fail',
            offendingFindings: [{ severity: 'high', summary: 'unfounded issue' }],
          }),
          runFix: async () => ({
            invocationId: 'fix-1',
            agentOutcome: 'success',
            verdict: 'done_no_fixes_needed',
            rebuttal: 'unfounded',
          }),
        },
      },
      {
        name: 'arbiter finding_invalid',
        harnessOpts: {
          runReview: async () => ({
            invocationId: 'rev-1',
            agentOutcome: 'success',
            verdict: 'fail',
            offendingFindings: [{ severity: 'high', summary: 'disputed issue' }],
          }),
          runFix: async () => ({
            invocationId: 'fix-1',
            agentOutcome: 'success',
            verdict: 'done_no_fixes_needed',
            rebuttal: 'invalid finding',
          }),
          runArbiter: async () => ({
            outcome: 'finding_invalid',
            evidence: 'evidence shown invalid',
            rationale: 'finding is invalid',
          }),
        },
      },
      {
        name: 'trend-aware converged_with_notes',
        harnessOpts: {
          options: { trendAwareExit: { enabled: true, mode: 'strict' } },
          runReview: async () => {
            trendReviewCount++;
            if (trendReviewCount === 1) {
              return {
                invocationId: 'rev-1',
                agentOutcome: 'success',
                verdict: 'fail',
                offendingFindings: [
                  { severity: 'error', summary: 'bug 1' },
                  { severity: 'error', summary: 'bug 2' },
                ],
              };
            }
            return {
              invocationId: 'rev-2',
              agentOutcome: 'success',
              verdict: 'fail',
              offendingFindings: [{ severity: 'warning', summary: 'bug 1' }],
            };
          },
          runFix: async (ctx, _opts) => ({
            invocationId: `fix-${ctx.iterationIndex}`,
            agentOutcome: 'success',
            verdict: 'done_with_fixes',
          }),
        },
      },
    ];

    for (const c of cases) {
      trendReviewCount = 0;
      const harness = makeHarness({
        initialChangedFiles: ['src/fix.ts', 'src/fix.test.ts'],
        finalChangedFiles: ['src/fix.test.ts'],
        ...c.harnessOpts,
      });

      const result = await harness.loop.execute(c.input ?? inputWithBaseline());

      expect(result, `Failed on case: ${c.name}`).toMatchObject({
        phaseOutcome: 'failed',
        needsHumanReview: true,
      });
    }
  });
});
