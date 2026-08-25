import { describe, it, expect } from 'vitest';
import { RunId, PhaseName } from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { FakeLoopRepository } from '../../test-doubles/fake-loop-repository.js';
import { FakeReviewStateRepository } from '../../test-doubles/fake-review-state-repository.js';
import { FakeGitPort } from '../../test-doubles/fake-git-port.js';
import { PlanReviewLoop } from '../plan-review-loop.js';
import type {
  PlanReviewLoopDeps,
  PlanReviewResult,
  PlanFixResult,
  PlanReviewContext,
  PlanFixOptions,
  DeterministicPlanCheckResult,
  PlanReviewSnapshot,
} from '../types.js';
import type { EventBusPort } from '../../ports/event-bus-port.js';

function collectEvents() {
  const events: Array<{
    type: string;
    level: string;
    message: string;
    metadata: Record<string, unknown>;
  }> = [];
  const bus: EventBusPort = {
    publish: (_runUuid: string, e: OrchestratorEvent) =>
      events.push({ type: e.type, level: e.level, message: e.message, metadata: e.metadata }),
    subscribe: () => () => {},
  };
  return { events, bus };
}

function baseInput() {
  return {
    runId: RunId('run-1'),
    phaseId: PhaseName('plan-review'),
    repoId: 'owner/repo',
    cwd: '/wt',
    maxIterations: 3,
  };
}

function makeDeps(
  over: Partial<PlanReviewLoopDeps> = {},
  customGit?: FakeGitPort,
): {
  deps: PlanReviewLoopDeps;
  events: ReturnType<typeof collectEvents>['events'];
  fakeGit: FakeGitPort;
  loops: FakeLoopRepository;
  reviewStateRepository: FakeReviewStateRepository;
} {
  let n = 0;
  const { bus, events } = collectEvents();
  const fakeGit = customGit ?? new FakeGitPort();
  if (!fakeGit.headByCwd.has('/wt')) {
    fakeGit.headByCwd.set('/wt', 'base-sha-1');
  }
  const loops = new FakeLoopRepository();
  const reviewStateRepository = new FakeReviewStateRepository();

  const deps: PlanReviewLoopDeps = {
    git: fakeGit,
    readPlanMd: async (_cwd: string, _relativePath: string) => 'plan.md before-fix text\n',
    runReview: async (_ctx: PlanReviewContext): Promise<PlanReviewResult> => ({
      invocationId: `rev-${++n}`,
      agentOutcome: 'success',
      verdict: 'pass',
    }),
    runFix: async (_ctx: PlanReviewContext, _opts: PlanFixOptions): Promise<PlanFixResult> => ({
      invocationId: `fix-${++n}`,
      agentOutcome: 'success',
      verdict: 'done_with_fixes',
    }),
    checkDeterministicPlan: async (_ctx): Promise<DeterministicPlanCheckResult> => ({
      diagnostic: null,
      signatureBlastRadiusFailures: [],
    }),
    computeLastFixDiffCitations: (_cwd: string, _planMdBeforeFix: string | undefined) => [],
    captureSnapshot: async (_ctx: PlanReviewContext): Promise<PlanReviewSnapshot | undefined> => ({
      planMdDigest: 'snapshot-digest-1',
      planMdPath: '/wt/plan.md',
      capturedAt: '2026-08-23T00:00:00.000Z',
    }),
    runArbiter: undefined,
    loops,
    events: bus,
    now: () => new Date('2026-08-23T00:00:00.000Z'),
    idFactory: () => 'loop-1',
    reviewStateRepository,
    ...over,
  };

  return { deps, events, fakeGit, loops, reviewStateRepository };
}

describe('PlanReviewLoop Read-Only Guard', () => {
  it('automatically retries once when read-only violation cleanup succeeds, unblocking the run if retry is clean', async () => {
    const customGit = new FakeGitPort();
    customGit.headByCwd.set('/wt', 'base-sha-1');

    let reviewCallCount = 0;
    const { deps, events, reviewStateRepository } = makeDeps(
      {
        runReview: async () => {
          reviewCallCount++;
          if (reviewCallCount === 1) {
            // First attempt: reviewer creates untracked file
            customGit.statusByCwd.set('/wt', '?? apps/web/src/app/api/route.test.ts\n');
            return {
              invocationId: 'rev-1',
              agentOutcome: 'success',
              verdict: 'pass',
            };
          }
          // Retry attempt: worktree is clean, reviewer returns pass
          customGit.statusByCwd.set('/wt', '');
          return {
            invocationId: 'rev-2',
            agentOutcome: 'success',
            verdict: 'pass',
          };
        },
      },
      customGit,
    );

    const loop = new PlanReviewLoop(deps);
    const result = await loop.execute(baseInput());

    expect(result.outcome).toBe('success');
    expect(reviewCallCount).toBe(2);

    const violationEvents = events.filter((e) => e.type === 'plan-review.read_only_violation');
    expect(violationEvents).toHaveLength(1);
    expect(violationEvents[0]?.metadata.invocationId).toBe('rev-1');
    expect(violationEvents[0]?.metadata.files).toEqual(['apps/web/src/app/api/route.test.ts']);
    expect(violationEvents[0]?.metadata.resetSuccess).toBe(true);
    expect(violationEvents[0]?.metadata.cleanSuccess).toBe(true);

    const retryEvents = events.filter((e) => e.type === 'plan-review.read_only_violation.retry');
    expect(retryEvents).toHaveLength(1);
    expect(retryEvents[0]?.metadata.attempt).toBe(2);

    const attempts = reviewStateRepository.listAttempts(
      'run-1',
      'plan-review',
      'plan-review',
      'plan',
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.attemptId).toBe('rev-2');
  });

  it('escalates to needs_human_review when retry also produces a read-only violation', async () => {
    const customGit = new FakeGitPort();
    customGit.headByCwd.set('/wt', 'base-sha-1');

    let reviewCallCount = 0;
    const { deps, events } = makeDeps(
      {
        runReview: async () => {
          reviewCallCount++;
          customGit.statusByCwd.set('/wt', `?? leak-${reviewCallCount}.txt\n`);
          return {
            invocationId: `rev-${reviewCallCount}`,
            agentOutcome: 'success',
            verdict: 'pass',
          };
        },
      },
      customGit,
    );

    const loop = new PlanReviewLoop(deps);
    const result = await loop.execute(baseInput());

    expect(result.outcome).toBe('needs_human_review');
    expect(reviewCallCount).toBe(2);

    const violationEvents = events.filter((e) => e.type === 'plan-review.read_only_violation');
    expect(violationEvents).toHaveLength(2);
    expect(violationEvents[0]?.metadata.invocationId).toBe('rev-1');
    expect(violationEvents[1]?.metadata.invocationId).toBe('rev-2');

    const retryEvents = events.filter((e) => e.type === 'plan-review.read_only_violation.retry');
    expect(retryEvents).toHaveLength(1);
  });

  it('escalates immediately without retrying when cleanup fails', async () => {
    const customGit = new FakeGitPort();
    customGit.headByCwd.set('/wt', 'base-sha-1');
    customGit.statusByCwd.set('/wt', '?? dirty.txt\n');

    customGit.resetHard = async () => {
      throw new Error('reset hard failure');
    };

    let reviewCallCount = 0;
    const { deps, events } = makeDeps(
      {
        runReview: async () => {
          reviewCallCount++;
          return {
            invocationId: `rev-${reviewCallCount}`,
            agentOutcome: 'success',
            verdict: 'pass',
          };
        },
      },
      customGit,
    );

    const loop = new PlanReviewLoop(deps);
    const result = await loop.execute(baseInput());

    expect(result.outcome).toBe('needs_human_review');
    expect(reviewCallCount).toBe(1);

    const violationEvents = events.filter((e) => e.type === 'plan-review.read_only_violation');
    expect(violationEvents).toHaveLength(1);
    expect(violationEvents[0]?.metadata.resetSuccess).toBe(false);

    const retryEvents = events.filter((e) => e.type === 'plan-review.read_only_violation.retry');
    expect(retryEvents).toHaveLength(0);
  });

  it('allows findings-only output and consumes the reviewer verdict', async () => {
    const callOrder: string[] = [];
    const customGit = new FakeGitPort();
    customGit.headByCwd.set('/wt', 'base-sha-1');
    customGit.statusByCwd.set('/wt', '?? plan-review-findings.md\n');

    const origHeadCommitSha = customGit.headCommitSha.bind(customGit);
    customGit.headCommitSha = async (cwd: string) => {
      callOrder.push('headCommitSha');
      return origHeadCommitSha(cwd);
    };
    const origStatus = customGit.status.bind(customGit);
    customGit.status = async (cwd: string) => {
      callOrder.push('status');
      return origStatus(cwd);
    };

    const { deps, events, reviewStateRepository } = makeDeps(
      {
        captureSnapshot: async () => {
          callOrder.push('captureSnapshot');
          return {
            planMdDigest: 'digest-1',
            planMdPath: '/wt/plan.md',
            capturedAt: '2026-08-23T00:00:00.000Z',
          };
        },
        runReview: async () => {
          callOrder.push('runReview');
          return {
            invocationId: 'rev-1',
            agentOutcome: 'success',
            verdict: 'pass',
            findings: [],
          };
        },
      },
      customGit,
    );

    const loop = new PlanReviewLoop(deps);
    const result = await loop.execute(baseInput());

    expect(result.outcome).toBe('success');
    expect(callOrder[0]).toBe('headCommitSha');
    expect(callOrder[1]).toBe('captureSnapshot');
    expect(callOrder[2]).toBe('runReview');
    expect(callOrder[3]).toBe('headCommitSha');
    expect(callOrder[4]).toBe('status');
    expect(callOrder[5]).toBe('captureSnapshot');

    const violationEvents = events.filter((e) => e.type === 'plan-review.read_only_violation');
    expect(violationEvents).toHaveLength(0);
    expect(customGit.cleanUntrackedCalls).toHaveLength(0);

    const attempts = reviewStateRepository.listAttempts(
      'run-1',
      'plan-review',
      'plan-review',
      'plan',
    );
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts[0]?.attemptId).toBe('rev-1');
  });

  it('restores tracked and untracked reviewer writes and stops for human review', async () => {
    const callOrder: string[] = [];
    const customGit = new FakeGitPort();
    customGit.headByCwd.set('/wt', 'base-sha-1');

    const origResetHard = customGit.resetHard.bind(customGit);
    customGit.resetHard = async (cwd: string, sha: string) => {
      callOrder.push(`resetHard:${sha}`);
      return origResetHard(cwd, sha);
    };
    const origCleanUntracked = customGit.cleanUntracked.bind(customGit);
    customGit.cleanUntracked = async (cwd: string) => {
      callOrder.push('cleanUntracked');
      return origCleanUntracked(cwd);
    };

    let fixCalled = false;
    let arbiterCalled = false;
    let reviewCallCount = 0;

    const { deps, events, loops, reviewStateRepository } = makeDeps(
      {
        runReview: async () => {
          reviewCallCount++;
          // Simulate reviewer mutating worktree on every call
          customGit.statusByCwd.set(
            '/wt',
            ' M src/index.ts\n?? some-file.ts\n?? plan-review-findings.md\n',
          );
          return {
            invocationId: `rev-${reviewCallCount}`,
            agentOutcome: 'success',
            verdict: 'pass',
          };
        },
        runFix: async () => {
          fixCalled = true;
          return { invocationId: 'fix-1', agentOutcome: 'success', verdict: 'done_with_fixes' };
        },
        runArbiter: async () => {
          arbiterCalled = true;
          return {
            outcome: 'finding_valid',
            rationale: '',
            groundingSources: { planExcerpt: '', manifestExcerpt: '' },
          };
        },
      },
      customGit,
    );

    const loopRunner = new PlanReviewLoop(deps);
    const result = await loopRunner.execute(baseInput());

    expect(result.outcome).toBe('needs_human_review');
    expect(fixCalled).toBe(false);
    expect(arbiterCalled).toBe(false);
    expect(reviewCallCount).toBe(2);

    expect(callOrder).toContain('resetHard:base-sha-1');
    expect(callOrder).toContain('cleanUntracked');
    const resetIdx = callOrder.indexOf('resetHard:base-sha-1');
    const cleanIdx = callOrder.indexOf('cleanUntracked');
    expect(resetIdx).toBeLessThan(cleanIdx);

    const violationEvents = events.filter((e) => e.type === 'plan-review.read_only_violation');
    expect(violationEvents).toHaveLength(2);
    const violation = violationEvents[0]!;
    expect(violation.level).toBe('error');
    expect(violation.metadata.phase).toBe('plan-review');
    expect(violation.metadata.invocationId).toBe('rev-1');
    expect(violation.metadata.baselineSha).toBe('base-sha-1');
    expect(violation.metadata.endSha).toBe('base-sha-1');
    expect(violation.metadata.files).toEqual(['some-file.ts', 'src/index.ts']);
    expect(violation.metadata.resetSuccess).toBe(true);
    expect(violation.metadata.cleanSuccess).toBe(true);

    const attempts = reviewStateRepository.listAttempts(
      'run-1',
      'plan-review',
      'plan-review',
      'plan',
    );
    expect(attempts).toHaveLength(0);

    const persistedLoop = loops.findById('loop-1');
    expect(persistedLoop).toBeDefined();
    expect(persistedLoop?.iterations.length).toBeGreaterThan(0);
    const lastIter = persistedLoop?.iterations[persistedLoop.iterations.length - 1];
    expect(lastIter?.outcome).toMatch(/unresolved|failed/);
  });

  it('restores reviewer commits even when the net file diff is empty', async () => {
    const customGit = new FakeGitPort();
    customGit.headByCwd.set('/wt', 'base-sha-1');

    let reviewCallCount = 0;
    const { deps, events } = makeDeps(
      {
        runReview: async () => {
          reviewCallCount++;
          // Reviewer made a commit on each invocation
          const newSha = `commit-sha-${reviewCallCount + 1}`;
          customGit.headByCwd.set('/wt', newSha);
          customGit.changedFilesResults.set(`base-sha-1|${newSha}`, []);
          return {
            invocationId: `rev-${reviewCallCount}`,
            agentOutcome: 'success',
            verdict: 'pass',
          };
        },
      },
      customGit,
    );

    const loop = new PlanReviewLoop(deps);
    const result = await loop.execute(baseInput());

    expect(result.outcome).toBe('needs_human_review');
    expect(reviewCallCount).toBe(2);
    expect(customGit.headByCwd.get('/wt')).toBe('base-sha-1');

    const violationEvents = events.filter((e) => e.type === 'plan-review.read_only_violation');
    expect(violationEvents).toHaveLength(2);
    const violation = violationEvents[0]!;
    expect(violation.metadata.baselineSha).toBe('base-sha-1');
    expect(violation.metadata.endSha).toBe('commit-sha-2');
  });

  it('detects protected plan input mutation from snapshot drift', async () => {
    const customGit = new FakeGitPort();
    customGit.headByCwd.set('/wt', 'base-sha-1');

    let snapshotCount = 0;
    const { deps, events } = makeDeps(
      {
        captureSnapshot: async () => {
          snapshotCount++;
          // Every post-invocation snapshot call (even calls) returns a modified digest
          if (snapshotCount % 2 === 1) {
            return {
              planMdDigest: 'plan-digest-before',
              manifestDigest: 'manifest-digest-before',
              designDigest: 'design-digest-before',
              planMdPath: '/wt/plan.md',
              capturedAt: '2026-08-23T00:00:00.000Z',
            };
          }
          return {
            planMdDigest: 'plan-digest-after-modified',
            manifestDigest: 'manifest-digest-before',
            designDigest: 'design-digest-after-modified',
            planMdPath: '/wt/plan.md',
            capturedAt: '2026-08-23T00:01:00.000Z',
          };
        },
        runReview: async () => ({
          invocationId: 'rev-1',
          agentOutcome: 'success',
          verdict: 'pass',
        }),
      },
      customGit,
    );

    const loop = new PlanReviewLoop(deps);
    const result = await loop.execute(baseInput());

    expect(result.outcome).toBe('needs_human_review');
    const violationEvents = events.filter((e) => e.type === 'plan-review.read_only_violation');
    expect(violationEvents).toHaveLength(2);
    const violation = violationEvents[0]!;
    expect(violation.metadata.files).toEqual(['design.md', 'plan.md']);
    expect(customGit.cleanUntrackedCalls.length).toBeGreaterThan(0);
  });

  it('guards each reviewer retry independently', async () => {
    const customGit = new FakeGitPort();
    customGit.headByCwd.set('/wt', 'base-sha-1');

    let reviewInvocations = 0;
    const { deps, events } = makeDeps(
      {
        runReview: async () => {
          reviewInvocations++;
          if (reviewInvocations === 1) {
            // First outer reviewer retry loop attempt: clean failure (agent failed, no forbidden writes)
            return {
              invocationId: 'rev-1',
              agentOutcome: 'error',
            };
          }
          // Second outer reviewer retry loop invocation: writes forbidden file on both guard attempt 1 and guard attempt 2
          customGit.statusByCwd.set('/wt', `?? leak-${reviewInvocations}.txt\n`);
          return {
            invocationId: `rev-${reviewInvocations}`,
            agentOutcome: 'success',
            verdict: 'pass',
          };
        },
      },
      customGit,
    );

    const loop = new PlanReviewLoop(deps);
    const result = await loop.execute(baseInput());

    expect(result.outcome).toBe('needs_human_review');
    expect(reviewInvocations).toBe(3); // 1 initial failure + 2 guard attempts on the second reviewer invocation

    const retryEvents = events.filter((e) => e.type === 'plan-review.reviewer.retry');
    expect(retryEvents).toHaveLength(1);

    const failedEvents = events.filter((e) => e.type === 'plan-review.reviewer.failed');
    expect(failedEvents).toHaveLength(0);

    const violationEvents = events.filter((e) => e.type === 'plan-review.read_only_violation');
    expect(violationEvents).toHaveLength(2);
    expect(violationEvents[0]?.metadata.invocationId).toBe('rev-2');
  });

  it('guards post-reopen verification before consuming its result', async () => {
    const customGit = new FakeGitPort();
    customGit.headByCwd.set('/wt', 'base-sha-1');

    let reviewInvocation = 0;
    const { deps, events } = makeDeps(
      {
        runReview: async (_ctx, _opts): Promise<PlanReviewResult> => {
          reviewInvocation++;
          if (reviewInvocation === 1) {
            // Initial full review: finds P1
            return {
              invocationId: 'rev-1',
              agentOutcome: 'success',
              verdict: 'p1_found',
              findings: [
                {
                  severity: 'P1',
                  citation: 'plan.md:10',
                  failureScenario: 'defect 1',
                  evidence: 'grounded',
                },
              ],
            };
          }
          if (reviewInvocation === 2) {
            // Intermediate delta review: passes, triggering final full
            return {
              invocationId: 'rev-2',
              agentOutcome: 'success',
              verdict: 'pass',
              findings: [],
            };
          }
          if (reviewInvocation === 3) {
            // Final full review: finds P1, reopening cycle at max iterations
            return {
              invocationId: 'rev-3',
              agentOutcome: 'success',
              verdict: 'p1_found',
              findings: [
                {
                  severity: 'P1',
                  citation: 'plan.md:10',
                  failureScenario: 'defect 1',
                  evidence: 'grounded',
                },
              ],
            };
          }
          // Review 4+: Post-reopen verification review writes forbidden file
          customGit.statusByCwd.set('/wt', `?? leaked-${reviewInvocation}.js\n`);
          return {
            invocationId: `rev-post-reopen-${reviewInvocation}`,
            agentOutcome: 'success',
            verdict: 'pass',
          };
        },
      },
      customGit,
    );

    const loop = new PlanReviewLoop(deps);
    const result = await loop.execute({ ...baseInput(), maxIterations: 2 });

    expect(result.outcome).toBe('needs_human_review');
    const violationEvents = events.filter((e) => e.type === 'plan-review.read_only_violation');
    expect(violationEvents).toHaveLength(2);
    expect(violationEvents[0]?.metadata.invocationId).toBe('rev-post-reopen-4');
  });

  it('guards final full review before consuming its result', async () => {
    const customGit = new FakeGitPort();
    customGit.headByCwd.set('/wt', 'base-sha-1');

    let reviewInvocation = 0;
    const { deps, events } = makeDeps(
      {
        runReview: async () => {
          reviewInvocation++;
          if (reviewInvocation === 1) {
            // Iteration 1: finds P1
            return {
              invocationId: 'rev-1',
              agentOutcome: 'success',
              verdict: 'p1_found',
              findings: [
                {
                  severity: 'P1',
                  citation: 'plan.md:10',
                  failureScenario: 'defect 1',
                  evidence: 'grounded',
                },
              ],
            };
          }
          if (reviewInvocation === 2) {
            // Iteration 2 (intermediate_delta): passes, triggering final_full
            return {
              invocationId: 'rev-2',
              agentOutcome: 'success',
              verdict: 'pass',
              findings: [],
            };
          }
          // Review 3+: Final full review writes forbidden file
          customGit.statusByCwd.set('/wt', `?? leaked-${reviewInvocation}.ts\n`);
          return {
            invocationId: `rev-final-full-${reviewInvocation}`,
            agentOutcome: 'success',
            verdict: 'pass',
          };
        },
      },
      customGit,
    );

    const loop = new PlanReviewLoop(deps);
    const result = await loop.execute({ ...baseInput(), maxIterations: 3 });

    expect(result.outcome).toBe('needs_human_review');
    const violationEvents = events.filter((e) => e.type === 'plan-review.read_only_violation');
    expect(violationEvents).toHaveLength(2);
    expect(violationEvents[0]?.metadata.invocationId).toBe('rev-final-full-3');
  });

  it('guards bonus-fix confirmation before consuming its result', async () => {
    const customGit = new FakeGitPort();
    customGit.headByCwd.set('/wt', 'base-sha-1');

    let reviewInvocation = 0;
    const { deps, events } = makeDeps(
      {
        runReview: async () => {
          reviewInvocation++;
          if (reviewInvocation === 1) {
            // Iteration 1 finds P1
            return {
              invocationId: 'rev-1',
              agentOutcome: 'success',
              verdict: 'p1_found',
              findings: [
                {
                  severity: 'P1',
                  citation: 'plan.md:12',
                  failureScenario: 'Bug in spec',
                  evidence: 'grounded',
                },
              ],
            };
          }
          if (reviewInvocation === 2) {
            // Iteration 2 finds P1 again (exhausting standard iterations if maxIterations=2)
            return {
              invocationId: 'rev-2',
              agentOutcome: 'success',
              verdict: 'p1_found',
              findings: [
                {
                  severity: 'P1',
                  citation: 'plan.md:12',
                  failureScenario: 'Bug in spec',
                  evidence: 'grounded',
                },
              ],
            };
          }
          // Confirmation review after bonus fix writes forbidden file
          customGit.statusByCwd.set('/wt', `?? bonus_leaked-${reviewInvocation}.txt\n`);
          return {
            invocationId: `rev-confirm-${reviewInvocation}`,
            agentOutcome: 'success',
            verdict: 'pass',
          };
        },
        runArbiter: async () => ({
          outcome: 'finding_valid',
          rationale: 'valid defect',
          groundingSources: { planExcerpt: 'excerpt', manifestExcerpt: 'manifest' },
        }),
      },
      customGit,
    );

    const loop = new PlanReviewLoop(deps);
    const result = await loop.execute({ ...baseInput(), maxIterations: 2 });

    expect(result.outcome).toBe('needs_human_review');
    const violationEvents = events.filter((e) => e.type === 'plan-review.read_only_violation');
    expect(violationEvents).toHaveLength(2);
    expect(violationEvents[0]?.metadata.invocationId).toBe('rev-confirm-3');
  });

  it('attempts untracked cleanup when reset fails and reports both outcomes', async () => {
    const customGit = new FakeGitPort();
    customGit.headByCwd.set('/wt', 'base-sha-1');
    customGit.statusByCwd.set('/wt', '?? dirty.txt\n');

    customGit.resetHard = async () => {
      throw new Error('reset disk error');
    };

    const { deps, events } = makeDeps(
      {
        runReview: async () => ({
          invocationId: 'rev-1',
          agentOutcome: 'success',
          verdict: 'pass',
        }),
      },
      customGit,
    );

    const loop = new PlanReviewLoop(deps);
    const result = await loop.execute(baseInput());

    expect(result.outcome).toBe('needs_human_review');
    expect(customGit.cleanUntrackedCalls).toContain('/wt');

    const violationEvents = events.filter((e) => e.type === 'plan-review.read_only_violation');
    expect(violationEvents).toHaveLength(1);
    const violation = violationEvents[0]!;
    expect(violation.metadata.resetAttempted).toBe(true);
    expect(violation.metadata.resetSuccess).toBe(false);
    expect(violation.metadata.resetError).toBe('reset disk error');
    expect(violation.metadata.cleanAttempted).toBe(true);
    expect(violation.metadata.cleanSuccess).toBe(true);
  });

  it('reports clean failure and remains fail closed', async () => {
    const customGit = new FakeGitPort();
    customGit.headByCwd.set('/wt', 'base-sha-1');
    customGit.statusByCwd.set('/wt', '?? dirty.txt\n');

    customGit.cleanUntracked = async () => {
      throw new Error('clean lock error');
    };

    const { deps, events } = makeDeps(
      {
        runReview: async () => ({
          invocationId: 'rev-1',
          agentOutcome: 'success',
          verdict: 'pass',
        }),
      },
      customGit,
    );

    const loop = new PlanReviewLoop(deps);
    const result = await loop.execute(baseInput());

    expect(result.outcome).toBe('needs_human_review');

    const violationEvents = events.filter((e) => e.type === 'plan-review.read_only_violation');
    expect(violationEvents).toHaveLength(1);
    const violation = violationEvents[0]!;
    expect(violation.metadata.resetSuccess).toBe(true);
    expect(violation.metadata.cleanAttempted).toBe(true);
    expect(violation.metadata.cleanSuccess).toBe(false);
    expect(violation.metadata.cleanError).toBe('clean lock error');
  });

  it('fails closed when post-review state cannot be inspected', async () => {
    const customGit = new FakeGitPort();
    customGit.headByCwd.set('/wt', 'base-sha-1');

    customGit.status = async () => {
      throw new Error('git status failed unexpectedly');
    };

    const { deps, events } = makeDeps(
      {
        runReview: async () => ({
          invocationId: 'rev-1',
          agentOutcome: 'success',
          verdict: 'pass',
        }),
      },
      customGit,
    );

    const loop = new PlanReviewLoop(deps);
    const result = await loop.execute(baseInput());

    expect(result.outcome).toBe('needs_human_review');
    expect(customGit.cleanUntrackedCalls).toContain('/wt');

    const violationEvents = events.filter((e) => e.type === 'plan-review.read_only_violation');
    expect(violationEvents).toHaveLength(2);
    const violation = violationEvents[0]!;
    expect(violation.metadata.detectionError).toBe('git status failed unexpectedly');
  });

  it('fails closed when post-invocation snapshot capture throws after baseline snapshot was captured', async () => {
    const customGit = new FakeGitPort();
    customGit.headByCwd.set('/wt', 'base-sha-1');

    let captureCount = 0;
    const { deps, events } = makeDeps(
      {
        captureSnapshot: async () => {
          captureCount++;
          if (captureCount % 2 === 1) {
            return {
              planMdDigest: 'digest-1',
              planMdPath: '/wt/plan.md',
              capturedAt: '2026-08-23T00:00:00.000Z',
            };
          }
          throw new Error('snapshot disk read failure');
        },
        runReview: async () => ({
          invocationId: 'rev-1',
          agentOutcome: 'success',
          verdict: 'pass',
        }),
      },
      customGit,
    );

    const loop = new PlanReviewLoop(deps);
    const result = await loop.execute(baseInput());

    expect(result.outcome).toBe('needs_human_review');
    expect(customGit.cleanUntrackedCalls).toContain('/wt');

    const violationEvents = events.filter((e) => e.type === 'plan-review.read_only_violation');
    expect(violationEvents).toHaveLength(2);
    const violation = violationEvents[0]!;
    expect(violation.metadata.detectionError).toBe('snapshot disk read failure');
  });

  it('rejects nested plan-review-findings.md or .ai-runs paths as violations', async () => {
    const customGit = new FakeGitPort();
    customGit.headByCwd.set('/wt', 'base-sha-1');
    customGit.statusByCwd.set('/wt', '?? sub/plan-review-findings.md\n?? .ai-runs/log.txt\n');

    const { deps, events } = makeDeps(
      {
        runReview: async () => ({
          invocationId: 'rev-1',
          agentOutcome: 'success',
          verdict: 'pass',
        }),
      },
      customGit,
    );

    const loop = new PlanReviewLoop(deps);
    const result = await loop.execute(baseInput());

    expect(result.outcome).toBe('needs_human_review');
    const violationEvents = events.filter((e) => e.type === 'plan-review.read_only_violation');
    expect(violationEvents).toHaveLength(2);
    const violation = violationEvents[0]!;
    expect(violation.metadata.files).toEqual(['.ai-runs/log.txt', 'sub/plan-review-findings.md']);
  });

  it('guards contradiction arbiter against worktree mutations and cleans up', async () => {
    const customGit = new FakeGitPort();
    customGit.headByCwd.set('/wt', 'base-sha-1');

    let arbiterCallCount = 0;
    const { deps, events } = makeDeps(
      {
        runReview: async () => ({
          invocationId: 'rev-1',
          agentOutcome: 'success',
          verdict: 'p1_found',
          findings: [
            {
              severity: 'P1',
              citation: 'plan.md:10',
              failureScenario: 'defect 1',
              evidence: 'grounded',
            },
          ],
        }),
        runFix: async () => ({
          invocationId: 'fix-1',
          agentOutcome: 'success',
          verdict: 'done_no_fixes_needed',
          rebuttal: 'Disagreed with finding',
        }),
        runArbiter: async () => {
          arbiterCallCount++;
          // Arbiter writes forbidden file on each invocation
          customGit.statusByCwd.set('/wt', `?? arbiter-leak-${arbiterCallCount}.txt\n`);
          return {
            outcome: 'finding_valid',
            rationale: 'Finding is valid',
            evidence: 'plan excerpt quote',
            groundingSources: { planExcerpt: 'quote', manifestExcerpt: 'manifest' },
          };
        },
      },
      customGit,
    );

    const loop = new PlanReviewLoop(deps);
    const result = await loop.execute(baseInput());

    expect(result.outcome).toBe('needs_human_review');
    expect(arbiterCallCount).toBe(2);
    expect(customGit.cleanUntrackedCalls).toContain('/wt');

    const violationEvents = events.filter((e) => e.type === 'plan-review.read_only_violation');
    expect(violationEvents).toHaveLength(2);
    const violation = violationEvents[0]!;
    expect(violation.metadata.files).toEqual(['arbiter-leak-1.txt']);
  });

  it('guards final review arbiter against worktree mutations and cleans up', async () => {
    const customGit = new FakeGitPort();
    customGit.headByCwd.set('/wt', 'base-sha-1');

    let finalArbiterCalls = 0;
    let reviewCalls = 0;
    const { deps, events } = makeDeps(
      {
        runReview: async () => {
          reviewCalls++;
          return {
            invocationId: `rev-${reviewCalls}`,
            agentOutcome: 'success',
            verdict: 'p1_found',
            findings: [
              {
                severity: 'P1',
                citation: 'plan.md:10',
                failureScenario: 'defect 1',
                evidence: 'grounded',
              },
            ],
          };
        },
        runFix: async () => ({
          invocationId: 'fix-1',
          agentOutcome: 'success',
          verdict: 'done_with_fixes',
        }),
        runFinalReviewArbiter: async () => {
          finalArbiterCalls++;
          // Final arbiter writes forbidden file on each invocation
          customGit.statusByCwd.set('/wt', `?? final-arbiter-leak-${finalArbiterCalls}.txt\n`);
          return {
            outcome: 'finding_valid',
            rationale: 'Final defect is valid',
            evidence: 'plan excerpt quote',
            groundingSources: { planExcerpt: 'quote', manifestExcerpt: 'manifest' },
          };
        },
      },
      customGit,
    );

    const loop = new PlanReviewLoop(deps);
    const result = await loop.execute({ ...baseInput(), maxIterations: 2 });

    expect(result.outcome).toBe('needs_human_review');
    expect(finalArbiterCalls).toBe(2);
    expect(customGit.cleanUntrackedCalls).toContain('/wt');

    const violationEvents = events.filter((e) => e.type === 'plan-review.read_only_violation');
    expect(violationEvents).toHaveLength(2);
    const violation = violationEvents[0]!;
    expect(violation.metadata.files).toEqual(['final-arbiter-leak-1.txt']);
  });

  it('permits result.json output during arbiter invocation', async () => {
    const customGit = new FakeGitPort();
    customGit.headByCwd.set('/wt', 'base-sha-1');

    let arbiterCalled = false;
    const { deps, events } = makeDeps(
      {
        runReview: async () => ({
          invocationId: 'rev-1',
          agentOutcome: 'success',
          verdict: 'p1_found',
          findings: [
            {
              severity: 'P1',
              citation: 'plan.md:10',
              failureScenario: 'defect 1',
              evidence: 'grounded',
            },
          ],
        }),
        runFix: async () => ({
          invocationId: 'fix-1',
          agentOutcome: 'success',
          verdict: 'done_no_fixes_needed',
          rebuttal: 'Disagreed with finding',
        }),
        runArbiter: async () => {
          arbiterCalled = true;
          // Arbiter produces permitted result.json in status
          customGit.statusByCwd.set('/wt', '?? result.json\n');
          return {
            outcome: 'finding_invalid',
            rationale: 'Finding is invalid',
            evidence: 'plan excerpt quote',
            groundingSources: { planExcerpt: 'quote', manifestExcerpt: 'manifest' },
          };
        },
      },
      customGit,
    );

    const loop = new PlanReviewLoop(deps);
    const result = await loop.execute(baseInput());

    expect(result.outcome).toBe('success');
    expect(arbiterCalled).toBe(true);
    const violationEvents = events.filter((e) => e.type === 'plan-review.read_only_violation');
    expect(violationEvents).toHaveLength(0);
  });
});
