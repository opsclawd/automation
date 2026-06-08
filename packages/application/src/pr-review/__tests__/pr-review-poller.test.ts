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
  processed: 0,
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
  it('exits all_resolved after 3 consecutive quiet polls', async () => {
    const { poller, events } = makePoller([resolved(), resolved(), resolved()]);
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
    expect(
      events.some((e) => (e.event as { type: string }).type === 'post-pr-review.poll.all_resolved'),
    ).toBe(true);
  });

  it('resets consecutiveQuietPolls when processed > 0', async () => {
    const processed = (): PollPassResult => ({
      outcome: 'ALL_DONE',
      processed: 1,
      blocked: 0,
      allResolved: true,
      rateLimited: false,
    });
    const { poller } = makePoller([resolved(), processed(), resolved(), resolved(), resolved()], {
      maxPolls: 10,
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
    expect(result.pollsRun).toBe(5);
  });

  it('reaches max_polls_reached when quiet poll threshold is never met', async () => {
    const { poller } = makePoller([partial(), resolved(), partial(), resolved(), partial()], {
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
    expect(result.terminalState).toBe('max_polls_reached');
    expect(result.pollsRun).toBe(5);
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
    expect(terminalStates).toEqual([
      { runId: String(runId), state: 'running' },
      { runId: String(runId), state: 'running' },
      { runId: String(runId), state: 'max_polls_reached' },
    ]);
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

  it('persists nextPollAt before sleeping between polls', async () => {
    const scheduleCalls: Array<{ state: string; nextPollAt?: Date }> = [];
    const { poller } = makePoller([partial(), partial(), resolved()], {
      maxPolls: 5,
      recordTerminalState: async (_attempt, state, nextPollAt) => {
        scheduleCalls.push({ state, nextPollAt });
      },
    });
    await poller.run({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/w',
      phaseId: PhaseName('post-pr-review'),
    });
    expect(scheduleCalls).toHaveLength(5);
    expect(scheduleCalls[0].state).toBe('running');
    expect(scheduleCalls[0].nextPollAt).toBeInstanceOf(Date);
    expect(scheduleCalls[1].state).toBe('running');
    expect(scheduleCalls[1].nextPollAt).toBeInstanceOf(Date);
    expect(scheduleCalls[4].state).toBe('all_resolved');
  });
});

describe('PrReviewPoller — rate limit', () => {
  it('backs off and retries the same poll number on rate limit', async () => {
    const { poller, sleeps, events } = makePoller([rateLimited(), resolved()], {
      quietPollsThreshold: 999,
    });
    const result = await poller.run({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/w',
      phaseId: PhaseName('post-pr-review'),
    });
    expect(result.terminalState).toBe('max_polls_reached');
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
    expect(recordCalls).toHaveLength(2);
    expect(recordCalls[0].attempt).toBe(fakeAttempt);
    expect(recordCalls[0].state).toBe('running');
    expect(recordCalls[1].attempt).toBe(fakeAttempt);
    expect(recordCalls[1].state).toBe('timed_out');
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
      quietPollsThreshold: 999,
    });
    const result = await poller.run({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/w',
      phaseId: PhaseName('post-pr-review'),
    });
    expect(result.terminalState).toBe('max_polls_reached');
    expect(result.pollsRun).toBe(5);
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

describe('PrReviewPoller — resume from persisted poll attempts', () => {
  it('seeds pollsRun and pollNumber from existing attempts on resume', async () => {
    const repo = new FakePrReviewRepository();
    const terminalStates: Array<{ state: string }> = [];
    const eventTypes: string[] = [];
    let clock = new Date('2026-06-04T00:00:00Z');

    repo.insertPollAttempt({
      id: 'existing-1',
      runId,
      prNumber: 5,
      pollNumber: 1,
      status: 'completed',
      commentsFetched: 1,
      commentsProcessed: 1,
      startedAt: new Date('2026-06-03T22:00:00Z'),
      completedAt: new Date('2026-06-03T22:01:00Z'),
    });
    repo.insertPollAttempt({
      id: 'existing-2',
      runId,
      prNumber: 5,
      pollNumber: 2,
      status: 'completed',
      commentsFetched: 1,
      commentsProcessed: 0,
      startedAt: new Date('2026-06-03T23:00:00Z'),
      completedAt: new Date('2026-06-03T23:01:00Z'),
    });

    const deps: PrReviewPollerDeps = {
      prReviewRepo: repo,
      processOnePass: async () => ({ result: resolved(), attempt: undefined }),
      eventBus: {
        publish: (_runUuid: string, event: unknown) =>
          eventTypes.push((event as { type: string }).type),
      } as never,
      sleep: async (ms: number) => {
        clock = new Date(clock.getTime() + ms);
      },
      now: () => clock,
      maxPolls: 3,
      pollIntervalMs: 1000,
      readyMaxDays: 7,
      phaseStartedAt: clock,
      recordTerminalState: async (_attempt, state) => {
        terminalStates.push({ state });
      },
    };
    const poller = new PrReviewPoller(deps);
    const result = await poller.run({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/w',
      phaseId: PhaseName('post-pr-review'),
    });
    expect(result.terminalState).toBe('max_polls_reached');
    expect(result.pollsRun).toBe(3);
    expect(eventTypes).toContain('post-pr-review.poll.started');
    expect(terminalStates).toEqual([{ state: 'max_polls_reached' }]);
  });

  it('does not run any polls if maxPolls budget is already exhausted', async () => {
    const repo = new FakePrReviewRepository();
    const eventTypes: string[] = [];

    for (let i = 1; i <= 3; i++) {
      repo.insertPollAttempt({
        id: `existing-${i}`,
        runId,
        prNumber: 5,
        pollNumber: i,
        status: 'completed',
        commentsFetched: 1,
        commentsProcessed: 0,
        startedAt: new Date(`2026-06-03T${20 + i}:00:00Z`),
        completedAt: new Date(`2026-06-03T${20 + i}:01:00Z`),
      });
    }

    const deps: PrReviewPollerDeps = {
      prReviewRepo: repo,
      processOnePass: async () => {
        throw new Error('should not be called');
      },
      eventBus: {
        publish: (_runUuid: string, event: unknown) =>
          eventTypes.push((event as { type: string }).type),
      } as never,
      sleep: async () => {},
      now: () => new Date('2026-06-04T00:00:00Z'),
      maxPolls: 3,
      pollIntervalMs: 1000,
      readyMaxDays: 7,
      phaseStartedAt: new Date('2026-06-04T00:00:00Z'),
      recordTerminalState: async () => {},
    };
    const poller = new PrReviewPoller(deps);
    const result = await poller.run({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/w',
      phaseId: PhaseName('post-pr-review'),
    });
    expect(result.terminalState).toBe('max_polls_reached');
    expect(result.pollsRun).toBe(3);
    expect(eventTypes).not.toContain('post-pr-review.poll.started');
  });

  it('does not count rate_limited attempts toward poll budget on resume', async () => {
    const repo = new FakePrReviewRepository();
    let clock = new Date('2026-06-04T00:00:00Z');
    const pollNumbers: number[] = [];

    repo.insertPollAttempt({
      id: 'existing-rl',
      runId,
      prNumber: 5,
      pollNumber: 1,
      status: 'rate_limited',
      commentsFetched: 0,
      commentsProcessed: 0,
      startedAt: new Date('2026-06-03T22:00:00Z'),
      completedAt: new Date('2026-06-03T22:01:00Z'),
    });

    const deps: PrReviewPollerDeps = {
      prReviewRepo: repo,
      processOnePass: async (input) => {
        pollNumbers.push(input.pollNumber);
        return { result: resolved(), attempt: undefined };
      },
      eventBus: { publish: () => {} } as never,
      sleep: async (ms: number) => {
        clock = new Date(clock.getTime() + ms);
      },
      now: () => clock,
      maxPolls: 3,
      pollIntervalMs: 1000,
      readyMaxDays: 7,
      phaseStartedAt: clock,
      recordTerminalState: async () => {},
      quietPollsThreshold: 999,
    };
    const poller = new PrReviewPoller(deps);
    const result = await poller.run({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/w',
      phaseId: PhaseName('post-pr-review'),
    });
    expect(result.terminalState).toBe('max_polls_reached');
    expect(pollNumbers).toEqual([1, 2, 3]);
    expect(result.pollsRun).toBe(3);
  });
});

describe('PrReviewPoller — transient error recovery', () => {
  it('retries the same poll number after processOnePass throws', async () => {
    let callCount = 0;
    const { poller, sleeps, events } = makePoller([], {
      maxPolls: 3,
      quietPollsThreshold: 999,
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
    expect(result.terminalState).toBe('max_polls_reached');
    expect(result.pollsRun).toBe(3);
    expect(sleeps).toContain(60_000);
    expect(
      events.some((e) => (e.event as { type: string }).type === 'post-pr-review.poll.failed'),
    ).toBe(true);
  });

  it('terminates as max_polls_reached after MAX_EXCEPTION_RETRIES consecutive failures', async () => {
    const { poller, events } = makePoller([], {
      maxPolls: 10,
      processOnePass: async () => {
        throw new Error('permanent bug');
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
    expect(result.terminalState).toBe('max_polls_reached');
    expect(result.pollsRun).toBe(0);
    expect(
      events.filter((e) => (e.event as { type: string }).type === 'post-pr-review.poll.failed'),
    ).toHaveLength(3);
    expect(
      events.some(
        (e) => (e.event as { type: string }).type === 'post-pr-review.poll.max_retries_reached',
      ),
    ).toBe(true);
  });

  it('resets consecutive failure counter after a successful pass', async () => {
    let callCount = 0;
    const { poller, events } = makePoller([], {
      maxPolls: 10,
      processOnePass: async () => {
        callCount++;
        if (callCount === 1 || callCount === 3) throw new Error('transient');
        return { result: partial(), attempt: undefined };
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
    expect(
      events.filter((e) => (e.event as { type: string }).type === 'post-pr-review.poll.failed'),
    ).toHaveLength(2);
    expect(result.pollsRun).toBeGreaterThan(0);
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
