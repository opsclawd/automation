import { describe, it, expect } from 'vitest';
import {
  RunId,
  RepositoryId,
  PhaseName,
  PollAttempt,
  createPrReviewComment,
  blockComment,
  markReplied,
} from '@ai-sdlc/domain';
import { FakePrReviewRepository } from '../../test-doubles/index.js';
import {
  PrReviewPoller,
  type PrReviewPollerDeps,
  type PollPassResult,
} from '../pr-review-poller.js';

const runId = RunId('55555555-5555-5555-5555-555555555555');
const repoId = RepositoryId('o/r');

function makePoller(passes: PollPassResult[], overrides: Partial<PrReviewPollerDeps> = {}) {
  const repo = new FakePrReviewRepository();
  const events: Array<{ runUuid: string; event: unknown }> = [];
  const terminalStates: Array<{ runId: string; state: string }> = [];
  let i = 0;
  const sleeps: number[] = [];
  let clock = new Date('2026-06-04T00:00:00Z');

  const deps: PrReviewPollerDeps = {
    prReviewRepo: repo,
    processOnePass: async () => {
      const result = passes[Math.min(i++, passes.length - 1)];
      return { result, attempt: undefined };
    },
    eventBus: {
      publish: (runUuid: string, event: unknown) => events.push({ runUuid, event }),
    } as never,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock = new Date(clock.getTime() + ms);
    },
    now: () => clock,
    maxPolls: 3,
    pollIntervalMs: 1000,
    readyMaxDays: 7,
    phaseStartedAt: clock,
    recordTerminalState: async (_attempt, state) => {
      terminalStates.push({ runId: String(runId), state });
    },
    ...overrides,
  };
  return { poller: new PrReviewPoller(deps), repo, events, sleeps, terminalStates };
}

const resolved = (): PollPassResult => ({
  outcome: 'ALL_DONE',
  processed: 1,
  blocked: 0,
  allResolved: true,
  rateLimited: false,
});
const partial = (): PollPassResult => ({
  outcome: 'PARTIAL',
  processed: 0,
  blocked: 0,
  allResolved: false,
  rateLimited: false,
});
const rateLimited = (): PollPassResult => ({
  outcome: 'RATE_LIMITED',
  processed: 0,
  blocked: 0,
  allResolved: false,
  rateLimited: true,
});

describe('PrReviewPoller', () => {
  it('stops at the first all-resolved pass', async () => {
    const { poller, events, terminalStates } = makePoller([resolved()]);
    const result = await poller.run({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/w',
      phaseId: PhaseName('post-pr-review'),
    });
    expect(result.terminalState).toBe('all_resolved');
    expect(result.pollsRun).toBe(1);
    expect(
      events.some((e) => (e.event as { type: string }).type === 'post-pr-review.poll.all_resolved'),
    ).toBe(true);
    expect(terminalStates).toEqual([{ runId: String(runId), state: 'all_resolved' }]);
  });

  it('runs up to maxPolls then terminates as max_polls_reached', async () => {
    const { poller, terminalStates } = makePoller([partial(), partial(), partial()]);
    const result = await poller.run({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/w',
      phaseId: PhaseName('post-pr-review'),
    });
    expect(result.pollsRun).toBe(3);
    expect(result.terminalState).toBe('max_polls_reached');
    expect(terminalStates).toEqual([{ runId: String(runId), state: 'max_polls_reached' }]);
  });

  it('sleeps the configured interval between polls but not after the last', async () => {
    const { poller, sleeps } = makePoller([partial(), partial(), partial()]);
    await poller.run({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/w',
      phaseId: PhaseName('post-pr-review'),
    });
    expect(sleeps).toEqual([1000, 1000]);
  });
});

describe('PrReviewPoller — rate limit', () => {
  it('backs off and retries the same poll number on rate limit', async () => {
    const { poller, sleeps, events } = makePoller([rateLimited(), resolved()]);
    const result = await poller.run({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/w',
      phaseId: PhaseName('post-pr-review'),
    });
    expect(result.terminalState).toBe('all_resolved');
    expect(sleeps).toContain(60_000);
    expect(
      events.some((e) => (e.event as { type: string }).type === 'post-pr-review.poll.rate_limited'),
    ).toBe(true);
  });
});

describe('PrReviewPoller — global timeout', () => {
  it('terminates as timed_out when the readyMaxDays deadline has passed', async () => {
    const pastStart = new Date('2026-05-20T00:00:00Z');
    const { poller } = makePoller([partial(), partial(), partial()], {
      readyMaxDays: 7,
      phaseStartedAt: pastStart,
    });
    const result = await poller.run({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/w',
      phaseId: PhaseName('post-pr-review'),
    });
    expect(result.terminalState).toBe('timed_out');
    expect(result.pollsRun).toBe(0);
  });
  it('passes lastAttempt to recordTerminalState on timeout after a prior poll ran', async () => {
    let pollRan = false;
    const recordCalls: Array<unknown> = [];
    const start = new Date('2026-06-04T00:00:00Z');
    const fakeAttempt = { runUuid: 'x', pollNumber: 1, status: 'completed' } as PollAttempt &
      Record<string, unknown>;
    const { poller } = makePoller([], {
      maxPolls: 5,
      readyMaxDays: 1,
      phaseStartedAt: start,
      now: () => {
        if (!pollRan) return start;
        return new Date('2026-06-05T00:00:00Z');
      },
      processOnePass: async () => {
        pollRan = true;
        return {
          result: partial(),
          attempt: fakeAttempt,
        };
      },
      recordTerminalState: async (attempt, state) => {
        recordCalls.push({ attempt, state });
      },
      sleep: async () => {},
    });
    const result = await poller.run({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/w',
      phaseId: PhaseName('post-pr-review'),
    });
    expect(result.terminalState).toBe('timed_out');
    expect(result.pollsRun).toBe(1);
    expect(recordCalls).toHaveLength(1);
    expect(recordCalls[0].attempt).toBe(fakeAttempt);
    expect(recordCalls[0].state).toBe('timed_out');
  });
});

const allBlocked = (): PollPassResult => ({
  outcome: 'PARTIAL',
  processed: 0,
  blocked: 1,
  allResolved: false,
  rateLimited: false,
});

describe('PrReviewPoller — blocked early-stop', () => {
  it('stops immediately as blocked when no comments are in-flight and a pass produces blocked > 0 with processed = 0', async () => {
    const { poller, repo } = makePoller([allBlocked()], { maxPolls: 5 });
    const c = createPrReviewComment({
      runId,
      prNumber: 5,
      commentId: 9001,
      path: 'a.ts',
      line: 1,
      reviewer: 'octocat',
      body: 'x',
      now: new Date(),
    });
    repo.upsertComment(blockComment(c, 'agent blocked'));

    const result = await poller.run({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/w',
      phaseId: PhaseName('post-pr-review'),
    });
    expect(result.terminalState).toBe('blocked');
    expect(result.pollsRun).toBe(1);
  });

  it('does NOT stop early when comments are still in replied state, even if current pass has blocked > 0 and processed = 0', async () => {
    const { poller, repo } = makePoller([allBlocked(), allBlocked(), resolved()], {
      maxPolls: 5,
    });
    const c = createPrReviewComment({
      runId,
      prNumber: 5,
      commentId: 9001,
      path: 'a.ts',
      line: 1,
      reviewer: 'octocat',
      body: 'x',
      now: new Date(),
    });
    const replied = markReplied(c, { replyId: 100, outcome: 'fixed', poll: 1 });
    repo.upsertComment(replied);

    const result = await poller.run({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/w',
      phaseId: PhaseName('post-pr-review'),
    });
    expect(result.pollsRun).toBeGreaterThan(1);
  });

  it('does not stop early when a pass has both processed and blocked comments', async () => {
    const mixed = (): PollPassResult => ({
      outcome: 'PARTIAL',
      processed: 1,
      blocked: 1,
      allResolved: false,
      rateLimited: false,
    });
    const { poller } = makePoller([mixed(), mixed(), resolved()], {
      maxPolls: 5,
    });
    const result = await poller.run({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/w',
      phaseId: PhaseName('post-pr-review'),
    });
    expect(result.terminalState).toBe('all_resolved');
    expect(result.pollsRun).toBe(3);
  });

  it('does NOT stop early when comments are still in pending state, even if current pass has blocked > 0 and processed = 0', async () => {
    const { poller, repo } = makePoller([allBlocked(), allBlocked(), resolved()], {
      maxPolls: 5,
    });
    const c = createPrReviewComment({
      runId,
      prNumber: 5,
      commentId: 9002,
      path: 'b.ts',
      line: 2,
      reviewer: 'octocat',
      body: 'y',
      now: new Date(),
    });
    repo.upsertComment(c);

    const result = await poller.run({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/w',
      phaseId: PhaseName('post-pr-review'),
    });
    expect(result.pollsRun).toBeGreaterThan(1);
  });
});

describe('PrReviewPoller — transient error recovery', () => {
  it('retries the same poll number after processOnePass throws', async () => {
    let callCount = 0;
    const { poller, sleeps, events } = makePoller([], {
      maxPolls: 3,
      processOnePass: async () => {
        callCount++;
        if (callCount === 1) throw new Error('GitHub API timeout');
        return { result: resolved(), attempt: undefined };
      },
    });
    const result = await poller.run({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/w',
      phaseId: PhaseName('post-pr-review'),
    });
    expect(result.terminalState).toBe('all_resolved');
    expect(result.pollsRun).toBe(1);
    expect(sleeps).toContain(60_000);
    expect(
      events.some((e) => (e.event as { type: string }).type === 'post-pr-review.poll.failed'),
    ).toBe(true);
  });

  it('retries on failure and terminates as timed_out when deadline passes during retry', async () => {
    let callCount = 0;
    const start = new Date('2026-06-04T00:00:00Z');
    const { poller, events } = makePoller([], {
      maxPolls: 5,
      readyMaxDays: 7,
      phaseStartedAt: start,
      now: () => {
        if (callCount === 0) return start;
        return new Date('2026-06-12T00:00:00Z');
      },
      processOnePass: async () => {
        callCount++;
        throw new Error('network down');
      },
    });
    const result = await poller.run({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/w',
      phaseId: PhaseName('post-pr-review'),
    });
    expect(result.terminalState).toBe('timed_out');
    expect(
      events.filter((e) => (e.event as { type: string }).type === 'post-pr-review.poll.failed'),
    ).toHaveLength(1);
  });
});
