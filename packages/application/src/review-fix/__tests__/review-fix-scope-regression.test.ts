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
  RevalidationResult,
  ReviewStepOptions,
  PostFixGateResult,
} from '../types.js';

type AnchoredReviewResult = ReviewStepResult & {
  offendingFindings: Array<{ severity: string; summary: string; files: string[] }>;
};

type ReasonedFixResult = FixStepResult & {
  outOfScopeReasons?: Record<string, string>;
};

function collectEvents() {
  const events: Array<{ type: string; metadata: Record<string, unknown> }> = [];
  const bus: EventBusPort = {
    publish: (_runUuid: string, e: OrchestratorEvent) =>
      events.push({ type: e.type, metadata: (e.metadata ?? {}) as Record<string, unknown> }),
    subscribe: () => () => {},
  };
  return { events, bus };
}

function baseInput(overrides?: Partial<ReviewFixLoopInput>): ReviewFixLoopInput {
  return {
    runId: RunId('run-scope-regression'),
    phaseId: PhaseName('review-fix'),
    repoId: 'owner/repo',
    cwd: '/worktree',
    maxIterations: 3,
    reviewProfile: AgentProfileName('review'),
    fixProfile: AgentProfileName('fix'),
    baselineCommitSha: 'run-start-sha',
    ...overrides,
  };
}

interface HarnessOptions {
  findingFiles?: string[];
  changedFiles?: string[];
  outOfScopeReasons?: Record<string, string>;
  branchType?: 'standard' | 'deterministic' | 'auto_commit';
}

function makeHarness(options: HarnessOptions = {}) {
  const { events, bus } = collectEvents();
  const git = new FakeGitPort();
  const baseSha = 'fix-base';
  const headSha = 'fix-head';
  const branchType = options.branchType ?? 'standard';

  git.headByCwd.set('/worktree', baseSha);

  const findingFiles = options.findingFiles ?? ['packages/api/src/handler.ts'];
  const changedFiles = options.changedFiles ?? ['packages/api/src/handler.ts', '.gitignore'];

  if (branchType === 'auto_commit') {
    git.statusByCwd.set('/worktree', 'M .gitignore');
    git.changedFilesResults.set(`${baseSha}|fake-sha-1`, changedFiles);
  } else if (branchType === 'deterministic') {
    git.changedFilesResults.set('fix-head-1|fix-head-2', changedFiles);
    git.changedFilesResults.set(`${baseSha}|fix-head-1`, ['packages/api/src/handler.ts']);
  } else {
    git.changedFilesResults.set(`${baseSha}|${headSha}`, changedFiles);
  }

  let reviewCount = 0;
  let secondReviewOpts: ReviewStepOptions | undefined;

  const runReview = async (_ctx: unknown, opts?: ReviewStepOptions): Promise<ReviewStepResult> => {
    reviewCount++;
    if (reviewCount === 1) {
      const res: AnchoredReviewResult = {
        invocationId: 'rev-1',
        agentOutcome: 'success',
        verdict: 'fail',
        offendingFindings: [
          {
            severity: 'error',
            summary: 'Missing guard in handler',
            files: findingFiles,
          },
        ],
      };
      return res;
    }
    secondReviewOpts = opts;
    return {
      invocationId: 'rev-2',
      agentOutcome: 'success',
      verdict: 'pass',
    };
  };

  let fixCount = 0;
  const runFix = async (_ctx: unknown, _opts: unknown): Promise<FixStepResult> => {
    fixCount++;
    const currentHead = await git.headCommitSha('/worktree');
    let nextHead = `fix-head-${fixCount}`;
    if (fixCount === 1 && branchType !== 'deterministic') {
      nextHead = headSha;
    }

    if (branchType === 'auto_commit') {
      const res: ReasonedFixResult = {
        invocationId: `fix-${fixCount}`,
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
        headBeforeFix: baseSha,
        ...(options.outOfScopeReasons ? { outOfScopeReasons: options.outOfScopeReasons } : {}),
      };
      return res;
    }

    await git.commit('/worktree', `fix ${fixCount}`);
    git.headByCwd.set('/worktree', nextHead);

    const res: ReasonedFixResult = {
      invocationId: `fix-${fixCount}`,
      agentOutcome: 'success',
      verdict: 'done_with_fixes',
      headBeforeFix: currentHead,
      ...(options.outOfScopeReasons ? { outOfScopeReasons: options.outOfScopeReasons } : {}),
    };
    return res;
  };

  let gateCalls = 0;
  const runPostFixGate = async (): Promise<PostFixGateResult> => {
    gateCalls++;
    if (branchType === 'deterministic' && gateCalls === 1) {
      return { outcome: 'fail', output: 'post-fix gate failed' };
    }
    return { outcome: 'pass', output: '' };
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
    format(_history, audience) {
      return `history formatted for ${audience}`;
    },
  };

  const deps: ReviewFixLoopDeps = {
    runPostFixGate,
    runReview,
    runFix,
    runRevalidation,
    loops,
    events: bus,
    now: () => new Date('2026-01-01T00:00:00Z'),
    idFactory: () => 'loop-scope-1',
    git,
    loopHistory,
  };

  const loop = new ReviewFixLoop(deps);

  return {
    loop,
    events,
    git,
    deps,
    getSecondReviewOpts: () => secondReviewOpts,
    getReviewCount: () => reviewCount,
  };
}

describe.skip('ReviewFixLoop scope regression proof', () => {
  it('detects the instance-1 gitignore edit outside package-scoped findings', async () => {
    const harness = makeHarness({
      findingFiles: ['packages/api/src/handler.ts'],
      changedFiles: ['packages/api/src/handler.ts', '.gitignore'],
    });
    const result = await harness.loop.execute(baseInput());
    expect(result.phaseOutcome).toBe('passed');
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        type: 'review_fix.out_of_scope_write',
        metadata: expect.objectContaining({
          allowedFiles: ['packages/api/src/handler.ts'],
          outOfScopeFiles: [{ path: '.gitignore', reason: 'No justification provided by fixer.' }],
        }),
      }),
    );
    expect(harness.getReviewCount()).toBe(2);
  });

  it('does not flag a committed file anchored by the active finding', async () => {
    const harness = makeHarness({
      findingFiles: ['packages/api/src/handler.ts'],
      changedFiles: ['packages/api/src/handler.ts'],
    });
    await harness.loop.execute(baseInput());
    expect(harness.events.some((e) => e.type === 'review_fix.out_of_scope_write')).toBe(false);
    const secondReviewOpts = harness.getSecondReviewOpts();
    expect(secondReviewOpts?.historyContext ?? '').not.toContain('Out-of-scope');
  });

  it("surfaces the fixer's reason for each out-of-scope file", async () => {
    const harness = makeHarness({
      findingFiles: ['packages/api/src/handler.ts'],
      changedFiles: ['packages/api/src/handler.ts', '.gitignore'],
      outOfScopeReasons: { '.gitignore': 'Updating ignore rules for build artifacts' },
    });
    await harness.loop.execute(baseInput());
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        type: 'review_fix.out_of_scope_write',
        metadata: expect.objectContaining({
          outOfScopeFiles: [
            { path: '.gitignore', reason: 'Updating ignore rules for build artifacts' },
          ],
        }),
      }),
    );
  });

  it('surfaces an explicit fallback when the fixer omits a reason', async () => {
    const harness = makeHarness({
      findingFiles: ['packages/api/src/handler.ts'],
      changedFiles: ['packages/api/src/handler.ts', '.gitignore'],
      outOfScopeReasons: {},
    });
    await harness.loop.execute(baseInput());
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        type: 'review_fix.out_of_scope_write',
        metadata: expect.objectContaining({
          outOfScopeFiles: [{ path: '.gitignore', reason: 'No justification provided by fixer.' }],
        }),
      }),
    );
  });

  it('surfaces a legitimate adjacent test edit without blocking the next review', async () => {
    const harness = makeHarness({
      findingFiles: ['packages/api/src/handler.ts'],
      changedFiles: ['packages/api/src/handler.ts', 'packages/api/src/handler.test.ts'],
      outOfScopeReasons: {
        'packages/api/src/handler.test.ts': 'Updated test assertion for bugfix',
      },
    });
    const result = await harness.loop.execute(baseInput());
    expect(result.phaseOutcome).toBe('passed');
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        type: 'review_fix.out_of_scope_write',
        metadata: expect.objectContaining({
          outOfScopeFiles: [
            {
              path: 'packages/api/src/handler.test.ts',
              reason: 'Updated test assertion for bugfix',
            },
          ],
        }),
      }),
    );
  });

  it('injects out-of-scope paths and reasons into the next reviewer context', async () => {
    const harness = makeHarness({
      findingFiles: ['packages/api/src/handler.ts'],
      changedFiles: ['packages/api/src/handler.ts', '.gitignore'],
      outOfScopeReasons: { '.gitignore': 'Updating ignore rules' },
    });
    await harness.loop.execute(baseInput());
    const secondOpts = harness.getSecondReviewOpts();
    expect(secondOpts?.historyContext).toBeDefined();
    expect(secondOpts?.historyContext).toContain('.gitignore');
    expect(secondOpts?.historyContext).toContain('Updating ignore rules');
  });

  it('assesses only the verified fixer commit range', async () => {
    const harness = makeHarness({
      findingFiles: ['packages/api/src/handler.ts'],
      changedFiles: ['packages/api/src/handler.ts'],
    });
    harness.git.changedFilesResults.set('run-start-sha|fix-head', [
      'packages/api/src/handler.ts',
      'unrelated.ts',
    ]);

    await harness.loop.execute(baseInput());
    expect(harness.events.some((e) => e.type === 'review_fix.out_of_scope_write')).toBe(false);
    expect(harness.git.changedFilesCalls).toContainEqual(
      expect.objectContaining({ base: 'fix-base', head: 'fix-head' }),
    );
  });

  it('amends a productive fix commit with finding-specific history', async () => {
    const harness = makeHarness({
      findingFiles: ['packages/api/src/handler.ts'],
      changedFiles: ['packages/api/src/handler.ts'],
    });
    await harness.loop.execute(baseInput());
    expect(
      harness.git.commits.some(
        (c) =>
          c.message.includes('Missing guard in handler') || c.message.startsWith('fix(review)'),
      ),
    ).toBe(true);
  });

  it('applies scope finalization to standard deterministic and auto-committed fixes', async () => {
    const branchTypes: Array<'standard' | 'deterministic' | 'auto_commit'> = [
      'standard',
      'deterministic',
      'auto_commit',
    ];

    for (const branchType of branchTypes) {
      const harness = makeHarness({
        branchType,
        findingFiles: ['packages/api/src/handler.ts'],
        changedFiles: ['packages/api/src/handler.ts', '.gitignore'],
      });
      const result = await harness.loop.execute(baseInput());
      expect(result.phaseOutcome, `Failed on branch: ${branchType}`).toBe('passed');
      expect(harness.events, `Failed on branch: ${branchType}`).toContainEqual(
        expect.objectContaining({
          type: 'review_fix.out_of_scope_write',
          metadata: expect.objectContaining({
            outOfScopeFiles: [
              { path: '.gitignore', reason: 'No justification provided by fixer.' },
            ],
          }),
        }),
      );
    }
  });
});
