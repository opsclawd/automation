import { describe, it, expect } from 'vitest';
import { createRun, transitionToReady, RunStateError, RepositoryId } from '@ai-sdlc/domain';
import { SweepWaitingRuns, type SweepWaitingRunsDeps } from '../sweep-waiting-runs.js';
import { FakeRunRepository } from '../test-doubles/fake-run-repository.js';
import { FakePrReviewRepository } from '../test-doubles/fake-pr-review-repository.js';
import { FakeGitHubPort } from '../test-doubles/fake-github-port.js';
import { FakeEventBus } from '../test-doubles/fake-event-bus.js';

function makeWaitingRun(uuid: string, completedAt: Date, prNumber = 7) {
  const run = createRun({
    uuid,
    displayId: `issue-${prNumber}-20260604-000000`,
    repoId: RepositoryId('owner/repo'),
    issueNumber: prNumber,
    startedAt: new Date('2026-06-04T00:00:00Z'),
    type: 'pr_review',
  });
  const running = { ...run, status: 'running' as const };
  const ready = transitionToReady(running);
  return { ...ready, completedAt, repoFullName: 'owner/repo', prNumber };
}

const fixedNow = new Date('2026-06-04T01:00:00Z');

function makeDeps(overrides: Partial<SweepWaitingRunsDeps> = {}): {
  deps: SweepWaitingRunsDeps;
  runRepo: FakeRunRepository;
  prReviewRepo: FakePrReviewRepository;
  github: FakeGitHubPort;
  eventBus: FakeEventBus;
  applyCalls: Array<{ uuid: string; action: string }>;
} {
  const runRepo = new FakeRunRepository();
  const prReviewRepo = new FakePrReviewRepository();
  const github = new FakeGitHubPort();
  github.prs.set('owner/repo/7', {
    number: 7,
    url: 'https://example/pr/7',
    state: 'open',
    headRefName: 'ai/issue-7',
  });
  const eventBus = new FakeEventBus();
  const applyCalls: Array<{ uuid: string; action: string }> = [];
  const deps: SweepWaitingRunsDeps = {
    runRepository: runRepo,
    prReviewRepo,
    github,
    eventBus,
    now: () => fixedNow,
    readyMaxDays: 7,
    applyReactivation: (run, decision) => {
      applyCalls.push({ uuid: run.uuid, action: decision.action });
      if (decision.action === 'reactivate') {
        runRepo.update(run.uuid, { status: 'running' });
        eventBus.publish(run.uuid, {
          runId: run.uuid,
          phase: 'post-pr-review',
          level: 'info',
          type: 'post-pr-review.run.reactivated',
          message: decision.reason,
          timestamp: fixedNow.toISOString(),
          metadata: { reason: decision.reason },
        });
      } else if (decision.action === 'timeout') {
        runRepo.update(run.uuid, {
          status: 'cancelled',
          completedAt: fixedNow,
          failureReason: decision.reason,
        });
        eventBus.publish(run.uuid, {
          runId: run.uuid,
          phase: 'post-pr-review',
          level: 'warn',
          type: 'post-pr-review.run.timed_out',
          message: decision.reason,
          timestamp: fixedNow.toISOString(),
          metadata: { reason: decision.reason },
        });
      }
    },
    resolvePrContext: async () => ({ repoFullName: 'owner/repo', prNumber: 7 }),
    ...overrides,
  };
  return { deps, runRepo, prReviewRepo, github, eventBus, applyCalls };
}

describe('SweepWaitingRuns', () => {
  it('reactivates a waiting run when there are new comments since lastSeenActivityAt', async () => {
    const { deps, runRepo, github, eventBus, applyCalls } = makeDeps();
    const run = makeWaitingRun('w1', new Date('2026-06-04T00:30:00Z'));
    runRepo.addRun(run);
    github.comments.set('owner/repo/7', [
      {
        id: 1,
        prNumber: 7,
        path: 'a.ts',
        line: 1,
        reviewer: 'octocat',
        body: 'needs work',
        createdAt: new Date('2026-06-04T00:45:00Z'),
      },
    ]);
    const sweep = new SweepWaitingRuns(deps);
    const result = await sweep.execute();
    expect(result.scanned).toBe(1);
    expect(result.reactivated).toBe(1);
    expect(result.stayedReady).toBe(0);
    expect(applyCalls).toEqual([{ uuid: 'w1', action: 'reactivate' }]);
    expect(runRepo.findByUuid('w1')?.status).toBe('running');
    expect(eventBus.published.some((e) => e.event.type === 'post-pr-review.run.reactivated')).toBe(
      true,
    );
  });

  it('stays ready when there are no new comments and the deadline has not elapsed', async () => {
    const { deps, runRepo, github, applyCalls } = makeDeps({ readyMaxDays: 7 });
    const run = makeWaitingRun('w2', new Date('2026-06-04T00:00:00Z'));
    runRepo.addRun(run);
    github.comments.set('owner/repo/7', []);
    const sweep = new SweepWaitingRuns(deps);
    const result = await sweep.execute();
    expect(result.scanned).toBe(1);
    expect(result.stayedReady).toBe(1);
    expect(result.reactivated).toBe(0);
    expect(result.timedOut).toBe(0);
    expect(applyCalls).toEqual([{ uuid: 'w2', action: 'stay_ready' }]);
    expect(runRepo.findByUuid('w2')?.status).toBe('waiting');
  });

  it('times out when readyMaxDays has elapsed with no new activity', async () => {
    const { deps, runRepo, github, applyCalls, eventBus } = makeDeps({ readyMaxDays: 1 });
    const run = makeWaitingRun('w3', new Date('2026-05-30T00:00:00Z'));
    runRepo.addRun(run);
    github.comments.set('owner/repo/7', []);
    const sweep = new SweepWaitingRuns(deps);
    const result = await sweep.execute();
    expect(result.scanned).toBe(1);
    expect(result.timedOut).toBe(1);
    expect(applyCalls).toEqual([{ uuid: 'w3', action: 'timeout' }]);
    expect(runRepo.findByUuid('w3')?.status).toBe('cancelled');
    expect(runRepo.findByUuid('w3')?.failureReason).toMatch(/readyMaxDays/);
    expect(eventBus.published.some((e) => e.event.type === 'post-pr-review.run.timed_out')).toBe(
      true,
    );
  });

  it('passes a run when the PR is already merged', async () => {
    const { deps, runRepo, github, eventBus } = makeDeps();
    const run = makeWaitingRun('w4', new Date('2026-06-04T00:30:00Z'));
    runRepo.addRun(run);
    github.prs.set('owner/repo/7', {
      number: 7,
      url: 'https://example/pr/7',
      state: 'merged',
      headRefName: 'ai/issue-7',
    });
    const sweep = new SweepWaitingRuns(deps);
    const result = await sweep.execute();
    expect(result.passedOnMergedPr).toBe(1);
    expect(result.skipped).toBe(0);
    expect(runRepo.findByUuid('w4')?.status).toBe('passed');
    expect(eventBus.published.some((e) => e.event.type === 'post-pr-review.run.passed')).toBe(true);
  });

  it('cancels a run when the PR is closed (not merged)', async () => {
    const { deps, runRepo, github, eventBus } = makeDeps();
    const run = makeWaitingRun('w5', new Date('2026-06-04T00:30:00Z'));
    runRepo.addRun(run);
    github.prs.set('owner/repo/7', {
      number: 7,
      url: 'https://example/pr/7',
      state: 'closed',
      headRefName: 'ai/issue-7',
    });
    const sweep = new SweepWaitingRuns(deps);
    const result = await sweep.execute();
    expect(result.cancelledOnClosedPr).toBe(1);
    expect(result.skipped).toBe(0);
    expect(runRepo.findByUuid('w5')?.status).toBe('cancelled');
    expect(runRepo.findByUuid('w5')?.failureReason).toBe('PR closed');
    expect(eventBus.published.some((e) => e.event.type === 'post-pr-review.run.cancelled')).toBe(
      true,
    );
  });

  it('skips runs with no resolvable PR context (artifact missing)', async () => {
    const { deps, runRepo, eventBus } = makeDeps({
      resolvePrContext: async () => undefined,
    });
    const run = makeWaitingRun('w6', new Date('2026-06-04T00:30:00Z'));
    runRepo.addRun(run);
    const sweep = new SweepWaitingRuns(deps);
    const result = await sweep.execute();
    expect(result.skipped).toBe(1);
    expect(result.reactivated).toBe(0);
    expect(result.stayedReady).toBe(0);
    expect(runRepo.findByUuid('w6')?.status).toBe('waiting');
    expect(
      eventBus.published.some(
        (e) =>
          e.event.type === 'post-pr-review.sweep.skipped' &&
          (e.event as { metadata?: { reason?: string } }).metadata?.reason ===
            'pr_context_unresolved',
      ),
    ).toBe(true);
  });

  it('continues after a per-run error and populates the errors[] array', async () => {
    const { deps, runRepo, github, applyCalls } = makeDeps();
    const r1 = makeWaitingRun('r1', new Date('2026-06-04T00:30:00Z'));
    const r2 = makeWaitingRun('r2', new Date('2026-06-04T00:30:00Z'));
    runRepo.addRun(r1);
    runRepo.addRun(r2);
    github.comments.set('owner/repo/7', [
      {
        id: 1,
        prNumber: 7,
        path: 'a.ts',
        line: 1,
        reviewer: 'octocat',
        body: 'fix me',
        createdAt: new Date('2026-06-04T00:45:00Z'),
      },
    ]);
    const original = deps.applyReactivation;
    deps.applyReactivation = (run, decision) => {
      if (run.uuid === 'r2') throw new Error('boom');
      return original(run, decision);
    };
    const sweep = new SweepWaitingRuns(deps);
    const result = await sweep.execute();
    expect(result.scanned).toBe(2);
    expect(result.reactivated).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.runId).toBe('r2');
    expect(result.errors[0]?.error).toMatch(/boom/);
    expect(applyCalls.find((a) => a.uuid === 'r1')?.action).toBe('reactivate');
    expect(runRepo.findByUuid('r1')?.status).toBe('running');
  });

  it('records concurrent_status_change (RunStateError) as an error, not a reactivation', async () => {
    const { deps, runRepo, applyCalls, eventBus } = makeDeps();
    const run = makeWaitingRun('w7', new Date('2026-06-04T00:30:00Z'));
    runRepo.addRun(run);
    deps.applyReactivation = () => {
      throw new RunStateError('cannot reactivate r7: status is "running"');
    };
    const sweep = new SweepWaitingRuns(deps);
    const result = await sweep.execute();
    expect(result.reactivated).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toMatch(/concurrent_status_change/);
    expect(
      eventBus.published.some(
        (e) =>
          e.event.type === 'post-pr-review.sweep.skipped' &&
          (e.event as { metadata?: { reason?: string } }).metadata?.reason ===
            'concurrent_status_change',
      ),
    ).toBe(true);
    expect(applyCalls).toEqual([]);
  });

  it('includes the reactivated run in reactivatedRuns, but not merged/closed finalizations', async () => {
    const { deps, runRepo, github } = makeDeps();
    const run = makeWaitingRun('w8', new Date('2026-06-04T00:30:00Z'));
    runRepo.addRun(run);
    github.comments.set('owner/repo/7', [
      {
        id: 1,
        prNumber: 7,
        path: 'a.ts',
        line: 1,
        reviewer: 'octocat',
        body: 'needs work',
        createdAt: new Date('2026-06-04T00:45:00Z'),
      },
    ]);
    const sweep = new SweepWaitingRuns(deps);
    const result = await sweep.execute();
    expect(result.reactivatedRuns).toHaveLength(1);
    expect(result.reactivatedRuns[0]?.run.uuid).toBe('w8');
    expect(result.reactivatedRuns[0]?.run.repoId).toBe('owner/repo');
    expect(result.reactivatedRuns[0]?.run.issueNumber).toBe(7);
  });

  it('does not include a merged-PR finalization in reactivatedRuns', async () => {
    const { deps, runRepo, github } = makeDeps();
    const run = makeWaitingRun('w9', new Date('2026-06-04T00:30:00Z'));
    runRepo.addRun(run);
    github.prs.set('owner/repo/7', {
      number: 7,
      url: 'https://example/pr/7',
      state: 'merged',
      headRefName: 'ai/issue-7',
    });
    const sweep = new SweepWaitingRuns(deps);
    const result = await sweep.execute();
    expect(result.passedOnMergedPr).toBe(1);
    expect(result.reactivatedRuns).toHaveLength(0);
  });

  it('does not include a closed-PR finalization in reactivatedRuns', async () => {
    const { deps, runRepo, github } = makeDeps();
    const run = makeWaitingRun('w10', new Date('2026-06-04T00:30:00Z'));
    runRepo.addRun(run);
    github.prs.set('owner/repo/7', {
      number: 7,
      url: 'https://example/pr/7',
      state: 'closed',
      headRefName: 'ai/issue-7',
    });
    const sweep = new SweepWaitingRuns(deps);
    const result = await sweep.execute();
    expect(result.cancelledOnClosedPr).toBe(1);
    expect(result.reactivatedRuns).toHaveLength(0);
  });
});
