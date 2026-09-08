import { describe, it, expect } from 'vitest';
import { RunId, PhaseName, AgentProfileName } from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import type { EventBusPort } from '../../ports/event-bus-port.js';
import { FakeGitPort } from '../../test-doubles/fake-git-port.js';
import { FakeLoopRepository } from '../../test-doubles/fake-loop-repository.js';
import { ReviewFixLoop } from '../review-fix-loop.js';
import type {
  ReviewFixLoopDeps,
  ReviewFixLoopInput,
  ReviewStepResult,
  FixStepResult,
  StepContext,
  ReviewStepOptions,
  PostFixGateResult,
  RevalidationResult,
} from '../types.js';

function baseInput(overrides?: Partial<ReviewFixLoopInput>): ReviewFixLoopInput {
  return {
    runId: RunId('run-validation-critical-proof'),
    phaseId: PhaseName('review-fix'),
    repoId: 'owner/repo',
    cwd: '/worktree',
    maxIterations: 5,
    reviewProfile: AgentProfileName('reviewer'),
    fixProfile: AgentProfileName('fixer'),
    baselineCommitSha: 'sha-baseline',
    manifest: {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1',
          expected_files: ['packages/api/src/handler.ts', 'packages/api/src/whisperx.ts'],
        },
      ],
    },
    ...overrides,
  };
}

function collectEvents() {
  const events: OrchestratorEvent[] = [];
  const bus: EventBusPort = {
    publish: (_runUuid: string, e: OrchestratorEvent) => events.push(e),
    subscribe: () => () => {},
  };
  return { events, bus };
}

describe('ReviewFixLoop validation-critical revert guard', () => {
  it('halts with needsHumanReview when a fixer reverts a validation-critical file to pre-fix state', async () => {
    const { events, bus } = collectEvents();
    const cwd = '/worktree';
    const git = new FakeGitPort();

    // Commit progression:
    // sha-0: initial state
    // Iteration 1: Review fails with finding on handler.ts. Fix commits sha-1. Gate fails!
    // Iteration 2: Deterministic fix touches whisperx.ts (from pre-fix 'timeout=10' to 'timeout=120'). Fix commits sha-2. Gate passes!
    // Iteration 3: Review flags whisperx.ts as out-of-scope. Fix commits sha-3 reverting whisperx.ts back to 'timeout=10'.
    // Revert guard must catch this at sha-3 and abort!

    git.headByCwd.set(cwd, 'sha-0');

    const fileContents = new Map<string, string>();
    fileContents.set('sha-0:packages/api/src/handler.ts', 'handler initial');
    fileContents.set('sha-0:packages/api/src/whisperx.ts', 'timeout=10');

    fileContents.set('sha-1:packages/api/src/handler.ts', 'handler fixed 1');
    fileContents.set('sha-1:packages/api/src/whisperx.ts', 'timeout=10');

    fileContents.set('sha-2:packages/api/src/handler.ts', 'handler fixed 1');
    fileContents.set('sha-2:packages/api/src/whisperx.ts', 'timeout=120');

    fileContents.set('sha-3:packages/api/src/handler.ts', 'handler fixed 1');
    fileContents.set('sha-3:packages/api/src/whisperx.ts', 'timeout=10'); // Reverted to sha-1 / sha-0 content!

    git.fileContent = async (_c, ref, path) => {
      const key = `${ref}:${path}`;
      const content = fileContents.get(key);
      if (content !== undefined) return content;
      return `default content for ${key}`;
    };

    git.changedFiles = async (_c, base, head) => {
      if (base === 'sha-0' && head === 'sha-1') return ['packages/api/src/handler.ts'];
      if (base === 'sha-1' && head === 'sha-2') return ['packages/api/src/whisperx.ts'];
      if (base === 'sha-2' && head === 'sha-3') return ['packages/api/src/whisperx.ts'];
      return ['packages/api/src/whisperx.ts'];
    };

    git.amendCommitMessage = async (c) => git.headCommitSha(c);

    let reviewCount = 0;
    const runReview = async (
      _ctx: StepContext,
      _opts?: ReviewStepOptions,
    ): Promise<ReviewStepResult> => {
      reviewCount++;
      if (reviewCount === 1) {
        return {
          invocationId: 'rev-1',
          agentOutcome: 'success',
          verdict: 'fail',
          offendingFindings: [
            {
              severity: 'high',
              summary: 'Bug in handler',
              files: ['packages/api/src/handler.ts'],
            },
          ],
        };
      }
      // Review 2 (after deterministic fix at iteration 2):
      return {
        invocationId: 'rev-2',
        agentOutcome: 'success',
        verdict: 'fail',
        offendingFindings: [
          {
            severity: 'high',
            summary: 'Revert whisperx modification',
            files: ['packages/api/src/whisperx.ts'],
          },
        ],
      };
    };

    let fixCount = 0;
    const runFix = async (_ctx: StepContext, _opts: unknown): Promise<FixStepResult> => {
      fixCount++;
      const currentHead = await git.headCommitSha(cwd);
      const nextHead = `sha-${fixCount}`;
      git.headByCwd.set(cwd, nextHead);

      return {
        invocationId: `fix-${fixCount}`,
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
        headBeforeFix: currentHead,
      };
    };

    let gateCount = 0;
    const runPostFixGate = async (): Promise<PostFixGateResult> => {
      gateCount++;
      // Iteration 1 post-fix gate fails:
      if (gateCount === 1) {
        return {
          outcome: 'fail',
          output: 'pnpm test:whisperx timed out',
        };
      }
      // Iteration 2 deterministic fix gate passes:
      return {
        outcome: 'pass',
        output: '',
      };
    };

    const runRevalidation = async (): Promise<RevalidationResult> => ({
      validationRunId: 'val-1',
      passed: true,
    });

    const loops = new FakeLoopRepository();
    const historyEntries: import('../types.js').ReviewLoopHistoryEntry[] = [];
    const loopHistory: ReviewFixLoopDeps['loopHistory'] = {
      async read() {
        return historyEntries;
      },
      async append(_ctx, entry) {
        historyEntries.push(entry);
      },
      format(_h, aud) {
        return `history for ${aud}`;
      },
    };

    const deps: ReviewFixLoopDeps = {
      runPostFixGate,
      runReview,
      runFix,
      runRevalidation,
      loops,
      events: bus,
      now: () => new Date('2026-09-01T00:00:00Z'),
      idFactory: () => 'loop-1',
      git,
      loopHistory,
    };

    const loop = new ReviewFixLoop(deps);
    const result = await loop.execute(baseInput());

    expect(result.phaseOutcome).toBe('failed');
    expect(result.needsHumanReview).toBe(true);
    expect(result.humanReviewReason).toContain(
      'Validation-critical file "packages/api/src/whisperx.ts" was reverted',
    );

    const revertedEvents = events.filter(
      (e) => e.type === 'review_fix.validation_critical_file_reverted',
    );
    expect(revertedEvents).toHaveLength(1);
    expect(revertedEvents[0].metadata).toEqual(
      expect.objectContaining({
        path: 'packages/api/src/whisperx.ts',
        diagnostic: 'pnpm test:whisperx timed out',
      }),
    );
  });

  it('pins Finding 4 fix: formats carve-out warning in the very next reviewer context after deterministic fix', async () => {
    const { bus } = collectEvents();
    const cwd = '/worktree';
    const git = new FakeGitPort();

    git.headByCwd.set(cwd, 'sha-0');

    const fileContents = new Map<string, string>();
    fileContents.set('sha-0:packages/api/src/handler.ts', 'handler initial');
    fileContents.set('sha-0:packages/api/src/whisperx.ts', 'timeout=10');

    fileContents.set('sha-1:packages/api/src/handler.ts', 'handler fixed 1');
    fileContents.set('sha-1:packages/api/src/whisperx.ts', 'timeout=10');

    fileContents.set('sha-2:packages/api/src/handler.ts', 'handler fixed 1');
    fileContents.set('sha-2:packages/api/src/whisperx.ts', 'timeout=120');

    git.fileContent = async (_c, ref, path) => {
      const key = `${ref}:${path}`;
      return fileContents.get(key) ?? `default for ${key}`;
    };

    git.changedFiles = async (_c, base, head) => {
      if (base === 'sha-0' && head === 'sha-1') return ['packages/api/src/handler.ts'];
      if (base === 'sha-1' && head === 'sha-2') return ['packages/api/src/whisperx.ts'];
      return [];
    };

    git.amendCommitMessage = async (c) => git.headCommitSha(c);

    const reviewOptsList: Array<ReviewStepOptions | undefined> = [];
    let reviewCount = 0;
    const runReview = async (
      _ctx: StepContext,
      opts?: ReviewStepOptions,
    ): Promise<ReviewStepResult> => {
      reviewCount++;
      reviewOptsList.push(opts);
      if (reviewCount === 1) {
        return {
          invocationId: 'rev-1',
          agentOutcome: 'success',
          verdict: 'fail',
          offendingFindings: [
            {
              severity: 'high',
              summary: 'Bug in handler',
              files: ['packages/api/src/handler.ts'],
            },
          ],
        };
      }
      return {
        invocationId: 'rev-2',
        agentOutcome: 'success',
        verdict: 'pass',
      };
    };

    let fixCount = 0;
    const runFix = async (_ctx: StepContext, _opts: unknown): Promise<FixStepResult> => {
      fixCount++;
      const currentHead = await git.headCommitSha(cwd);
      const nextHead = `sha-${fixCount}`;
      git.headByCwd.set(cwd, nextHead);

      return {
        invocationId: `fix-${fixCount}`,
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
        headBeforeFix: currentHead,
        outOfScopeReasons: {
          'packages/api/src/whisperx.ts': 'Fixed spawnSync timeout for test:whisperx',
        },
      };
    };

    let gateCount = 0;
    const runPostFixGate = async (): Promise<PostFixGateResult> => {
      gateCount++;
      if (gateCount === 1) {
        return {
          outcome: 'fail',
          output: 'pnpm test:whisperx timed out after 10000ms',
        };
      }
      return {
        outcome: 'pass',
        output: '',
      };
    };

    const runRevalidation = async (): Promise<RevalidationResult> => ({
      validationRunId: 'val-1',
      passed: true,
    });

    const loops = new FakeLoopRepository();
    const historyEntries: import('../types.js').ReviewLoopHistoryEntry[] = [];
    const loopHistory: ReviewFixLoopDeps['loopHistory'] = {
      async read() {
        return historyEntries;
      },
      async append(_ctx, entry) {
        historyEntries.push(entry);
      },
      format(_h, aud) {
        return `history for ${aud}`;
      },
    };

    const deps: ReviewFixLoopDeps = {
      runPostFixGate,
      runReview,
      runFix,
      runRevalidation,
      loops,
      events: bus,
      now: () => new Date('2026-09-01T00:00:00Z'),
      idFactory: () => 'loop-1',
      git,
      loopHistory,
    };

    const loop = new ReviewFixLoop(deps);
    const result = await loop.execute(baseInput());

    expect(result.phaseOutcome).toBe('passed');
    expect(reviewCount).toBe(2);

    // Review 2 was called immediately after Iteration 2's deterministic fix succeeded.
    const secondReviewOpts = reviewOptsList[1];
    expect(secondReviewOpts?.historyContext).toBeDefined();
    const historyCtx = secondReviewOpts?.historyContext ?? '';

    // Must contain the carve-out warning for whisperx.ts
    expect(historyCtx).toContain('Validation-critical modified files:');
    expect(historyCtx).toContain('packages/api/src/whisperx.ts');
    expect(historyCtx).toContain('Fixed spawnSync timeout for test:whisperx');
    expect(historyCtx).toContain('Do not instruct reverting them.');

    // Must NOT contain the generic "raise a high-severity finding for unrelated edits"
    expect(historyCtx).not.toContain('raise a high-severity finding for unrelated edits');
  });

  it('records validation-critical files on auto-commit path and halts when reverted in subsequent iteration', async () => {
    const { events, bus } = collectEvents();
    const cwd = '/worktree';
    const git = new FakeGitPort();

    git.headByCwd.set(cwd, 'sha-0');

    const fileContents = new Map<string, string>();
    fileContents.set('sha-0:packages/api/src/handler.ts', 'handler initial');
    fileContents.set('sha-0:packages/api/src/whisperx.ts', 'timeout=10');

    fileContents.set('sha-1:packages/api/src/handler.ts', 'handler initial');
    fileContents.set('sha-1:packages/api/src/whisperx.ts', 'timeout=120'); // auto-committed

    fileContents.set('sha-2:packages/api/src/handler.ts', 'handler initial');
    fileContents.set('sha-2:packages/api/src/whisperx.ts', 'timeout=10'); // reverted to sha-0

    git.fileContent = async (_c, ref, path) => {
      const key = `${ref}:${path}`;
      return fileContents.get(key) ?? `default content for ${key}`;
    };

    git.changedFiles = async (_c, base, head) => {
      if (base === 'sha-0' && head === 'sha-1') return ['packages/api/src/whisperx.ts'];
      if (base === 'sha-1' && head === 'sha-2') return ['packages/api/src/whisperx.ts'];
      return ['packages/api/src/whisperx.ts'];
    };

    git.commit = async (_cwd, _msg) => {
      git.headByCwd.set(cwd, 'sha-1');
      return 'sha-1';
    };

    git.amendCommitMessage = async (c) => git.headCommitSha(c);

    let reviewCount = 0;
    const runReview = async (
      _ctx: StepContext,
      _opts?: ReviewStepOptions,
    ): Promise<ReviewStepResult> => {
      reviewCount++;
      if (reviewCount === 1) {
        return {
          invocationId: 'rev-1',
          agentOutcome: 'success',
          verdict: 'fail',
          offendingFindings: [
            {
              severity: 'high',
              summary: 'Bug in handler',
              files: ['packages/api/src/handler.ts'],
            },
          ],
        };
      }
      return {
        invocationId: 'rev-2',
        agentOutcome: 'success',
        verdict: 'fail',
        offendingFindings: [
          {
            severity: 'high',
            summary: 'Revert whisperx modification',
            files: ['packages/api/src/whisperx.ts'],
          },
        ],
      };
    };

    let fixCount = 0;
    const runFix = async (_ctx: StepContext, _opts: unknown): Promise<FixStepResult> => {
      fixCount++;
      if (fixCount === 1) {
        // Fixer does not commit, but leaves uncommitted changes in whisperx.ts
        git.statusByCwd.set(cwd, ' M packages/api/src/whisperx.ts');
        return {
          invocationId: 'fix-1',
          agentOutcome: 'success',
          verdict: 'done_with_fixes',
          headBeforeFix: 'sha-0',
        };
      }

      // Fix 2: commits sha-2 which reverts whisperx.ts
      git.statusByCwd.set(cwd, '');
      git.headByCwd.set(cwd, 'sha-2');
      return {
        invocationId: 'fix-2',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
        headBeforeFix: 'sha-1',
      };
    };

    const runPostFixGate = async (): Promise<PostFixGateResult> => ({
      outcome: 'pass',
      output: '',
    });

    const runRevalidation = async (): Promise<RevalidationResult> => ({
      validationRunId: 'val-1',
      passed: true,
    });

    const loops = new FakeLoopRepository();
    const deps: ReviewFixLoopDeps = {
      runPostFixGate,
      runReview,
      runFix,
      runRevalidation,
      loops,
      events: bus,
      now: () => new Date('2026-09-01T00:00:00Z'),
      idFactory: () => 'loop-1',
      git,
    };

    const loop = new ReviewFixLoop(deps);
    const result = await loop.execute(baseInput());

    expect(result.phaseOutcome).toBe('failed');
    expect(result.needsHumanReview).toBe(true);
    expect(result.humanReviewReason).toContain(
      'Validation-critical file "packages/api/src/whisperx.ts" was reverted',
    );

    const revertedEvents = events.filter(
      (e) => e.type === 'review_fix.validation_critical_file_reverted',
    );
    expect(revertedEvents).toHaveLength(1);
    expect(revertedEvents[0].metadata).toEqual(
      expect.objectContaining({
        path: 'packages/api/src/whisperx.ts',
      }),
    );
  });
});
