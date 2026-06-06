import { describe, it, expect } from 'vitest';
import { RunId, RepositoryId, PhaseName, PollAttempt } from '@ai-sdlc/domain';
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
  const terminalStates: Array<{ runId: string; state: string; pollsRun: number }> = [];
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
    recordTerminalState: async (_attempt, state, pollsRun) => {
      terminalStates.push({ runId: String(runId), state, pollsRun });
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
    expect(terminalStates).toEqual([{ runId: String(runId), state: 'all_resolved', pollsRun: 1 }]);
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
      { runId: String(runId), state: 'max_polls_reached', pollsRun: 3 },
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
      recordTerminalState: async (attempt, state, pollsRun) => {
        recordCalls.push({ attempt, state, pollsRun });
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
