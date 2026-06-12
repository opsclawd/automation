import { describe, it, expect, vi, afterEach } from 'vitest';
import { parsePollArgs, exitCodeForTerminalState, runPoll, formatEvent } from '../run-pr-poll.js';
import type { PollArgs } from '../run-pr-poll.js';
import type { RunPollDeps } from '../run-pr-poll.js';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import type { PollerTerminalState } from '@ai-sdlc/application';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    unlinkSync: vi.fn(),
  };
});

const mockExistsSync = vi.mocked((await import('node:fs')).existsSync);
const mockUnlinkSync = vi.mocked((await import('node:fs')).unlinkSync);

describe('parsePollArgs', () => {
  it('parses required + optional flags', () => {
    const r = parsePollArgs([
      '--pr',
      '5',
      '--issue',
      '7',
      '--repo',
      'o/r',
      '--cwd',
      '/work/tree',
      '--max-polls',
      '3',
      '--interval-seconds',
      '300',
      '--run-id',
      'abc-123',
    ]);
    expect(r).toEqual({
      prNumber: 5,
      issueNumber: 7,
      repoFullName: 'o/r',
      cwd: '/work/tree',
      maxPolls: 3,
      pollIntervalSeconds: 300,
      runId: 'abc-123',
    });
  });

  it('defaults maxPolls=30 and pollIntervalSeconds=300 when omitted', () => {
    const r = parsePollArgs(['--pr', '5', '--repo', 'o/r', '--cwd', '/w']);
    expect(r.maxPolls).toBe(30);
    expect(r.pollIntervalSeconds).toBe(300);
    expect(r.runId).toBeUndefined();
    expect(r.issueNumber).toBeUndefined();
  });

  it('throws on missing --pr', () => {
    expect(() => parsePollArgs(['--repo', 'o/r', '--cwd', '/w'])).toThrow(/--pr/);
  });

  it('throws on missing --repo', () => {
    expect(() => parsePollArgs(['--pr', '5', '--cwd', '/w'])).toThrow(/--repo/);
  });

  it('throws on missing --cwd', () => {
    expect(() => parsePollArgs(['--pr', '5', '--repo', 'o/r'])).toThrow(/--cwd/);
  });

  it('rejects --pr <= 0', () => {
    expect(() => parsePollArgs(['--pr', '0', '--repo', 'o/r', '--cwd', '/w'])).toThrow(
      /--pr.*positive integer/,
    );
    expect(() => parsePollArgs(['--pr=-1', '--repo', 'o/r', '--cwd', '/w'])).toThrow(
      /--pr.*positive integer/,
    );
  });

  it('rejects --max-polls <= 0', () => {
    expect(() =>
      parsePollArgs(['--pr', '5', '--repo', 'o/r', '--cwd', '/w', '--max-polls', '0']),
    ).to.throw(/--max-polls.*positive integer/);
  });

  it('rejects --interval-seconds <= 0', () => {
    expect(() =>
      parsePollArgs(['--pr', '5', '--repo', 'o/r', '--cwd', '/w', '--interval-seconds=-5']),
    ).toThrow(/--interval-seconds.*positive integer/);
  });

  it('rejects non-integer numeric values', () => {
    expect(() => parsePollArgs(['--pr', '5.5', '--repo', 'o/r', '--cwd', '/w'])).toThrow(
      /--pr.*positive integer/,
    );
  });
});

describe('exitCodeForTerminalState', () => {
  it('maps all_resolved -> 0 (resting, not terminal)', () => {
    expect(exitCodeForTerminalState('all_resolved' as PollerTerminalState)).toBe(0);
  });
  it('maps max_polls_reached -> 0 (resting, not a failure)', () => {
    expect(exitCodeForTerminalState('max_polls_reached' as PollerTerminalState)).toBe(0);
  });
  it('maps blocked -> 0 (resting, no longer a hard terminal)', () => {
    expect(exitCodeForTerminalState('blocked' as PollerTerminalState)).toBe(0);
  });
  it('maps timed_out -> 2', () => {
    expect(exitCodeForTerminalState('timed_out' as PollerTerminalState)).toBe(2);
  });
  it('maps cancelled -> 2 (terminal timeout)', () => {
    expect(exitCodeForTerminalState('cancelled' as PollerTerminalState)).toBe(2);
  });
  it('maps unknown state -> 3', () => {
    expect(exitCodeForTerminalState('something_else' as PollerTerminalState)).toBe(3);
  });
});

function makeDeps(overrides: Partial<RunPollDeps> = {}): RunPollDeps {
  return {
    eventBus: {
      subscribe: vi.fn((_runUuid: string, _listener: (e: OrchestratorEvent) => void) => vi.fn()),
    },
    runRepository: {
      findByUuid: vi.fn(() => undefined),
      update: vi.fn(),
      insertIfNoActive: vi.fn(),
      findByIssueNumber: vi.fn(() => undefined),
      findActiveRuns: vi.fn(() => []),
      updateStatusByIssueNumber: vi.fn(() => false),
      updateStatusByUuid: vi.fn(() => false),
    },
    buildPrReviewPoller: vi.fn(() => ({
      run: vi.fn(async () => ({
        terminalState: 'all_resolved' as PollerTerminalState,
        pollsRun: 1,
      })),
    })),
    stderr: { write: vi.fn() } as unknown as NodeJS.WritableStream,
    repoRoot: '/tmp/test-repo',
    ...overrides,
  };
}

const defaultArgs: PollArgs = {
  prNumber: 42,
  issueNumber: 7,
  repoFullName: 'o/r',
  cwd: '/work/tree',
  maxPolls: 3,
  pollIntervalSeconds: 300,
};

describe('runPoll', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });
  it('subscribes to eventBus and writes events to stderr', async () => {
    const deps = makeDeps();
    const listener = vi.fn();
    deps.eventBus.subscribe = vi.fn((_uuid, cb) => {
      listener.mockImplementation(cb);
      return vi.fn();
    });

    const pollerRun = vi.fn(async () => ({
      terminalState: 'all_resolved' as PollerTerminalState,
      pollsRun: 2,
    }));
    deps.buildPrReviewPoller = vi.fn(() => ({ run: pollerRun }));

    const exitCode = await runPoll(defaultArgs, deps);

    expect(exitCode).toBe(0);
    expect(deps.eventBus.subscribe).toHaveBeenCalled();
    expect(deps.stderr.write).toHaveBeenCalledWith(expect.stringContaining('PID:'));
    expect(deps.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining('terminal=all_resolved'),
    );
  });

  it.each([
    ['all_resolved', 'waiting', 'update'],
    ['max_polls_reached', 'waiting', 'update'],
    ['blocked', 'waiting', 'update'],
    ['cancelled', 'cancelled', 'updateStatusByUuid'],
    ['timed_out', 'cancelled', 'updateStatusByUuid'],
  ] as const)(
    'updates run status to %s when terminal state is %s',
    async (terminalState, expectedStatus, expectedMethod) => {
      const deps = makeDeps();
      deps.buildPrReviewPoller = vi.fn(() => ({
        run: vi.fn(async () => ({ terminalState, pollsRun: 1 })),
      }));

      await runPoll(defaultArgs, deps);

      if (expectedMethod === 'update') {
        expect(deps.runRepository.update).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ status: expectedStatus }),
        );
      } else {
        expect(deps.runRepository.updateStatusByUuid).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ status: expectedStatus }),
        );
      }
    },
  );

  it('closes synthetic run as failed when poller throws', async () => {
    const deps = makeDeps();
    deps.buildPrReviewPoller = vi.fn(() => ({
      run: vi.fn(async () => {
        throw new Error('boom');
      }),
    }));

    await expect(runPoll(defaultArgs, deps)).rejects.toThrow('boom');
    expect(deps.runRepository.updateStatusByUuid).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('closes synthetic run as failed when buildPrReviewPoller throws', async () => {
    const deps = makeDeps();
    deps.buildPrReviewPoller = vi.fn(() => {
      throw new Error('missing agent config');
    });

    await expect(runPoll(defaultArgs, deps)).rejects.toThrow('missing agent config');
    expect(deps.runRepository.updateStatusByUuid).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('does not update status when buildPrReviewPoller throws and run was pre-existing', async () => {
    const deps = makeDeps();
    (deps.runRepository.findByUuid as ReturnType<typeof vi.fn>).mockReturnValue({
      uuid: 'existing',
      displayId: 'existing-run',
      status: 'running',
    });
    deps.buildPrReviewPoller = vi.fn(() => {
      throw new Error('missing agent config');
    });

    await expect(runPoll(defaultArgs, deps)).rejects.toThrow('missing agent config');
    expect(deps.runRepository.updateStatusByUuid).not.toHaveBeenCalled();
  });

  it('does not update status when poller throws and run was pre-existing', async () => {
    const deps = makeDeps();
    (deps.runRepository.findByUuid as ReturnType<typeof vi.fn>).mockReturnValue({
      uuid: 'existing',
      displayId: 'existing-run',
      status: 'running',
    });
    deps.buildPrReviewPoller = vi.fn(() => ({
      run: vi.fn(async () => {
        throw new Error('boom');
      }),
    }));

    await expect(runPoll(defaultArgs, deps)).rejects.toThrow('boom');
    expect(deps.runRepository.updateStatusByUuid).not.toHaveBeenCalled();
  });

  it('does not update status on success when run was pre-existing', async () => {
    const deps = makeDeps();
    (deps.runRepository.findByUuid as ReturnType<typeof vi.fn>).mockReturnValue({
      uuid: 'existing',
      displayId: 'existing-run',
      status: 'running',
    });

    await runPoll(defaultArgs, deps);

    expect(deps.runRepository.updateStatusByUuid).not.toHaveBeenCalled();
  });

  it('runs poller even when existing run is in terminal state', async () => {
    const deps = makeDeps();
    const pollerRun = vi.fn(async () => ({
      terminalState: 'all_resolved' as PollerTerminalState,
      pollsRun: 1,
    }));
    deps.buildPrReviewPoller = vi.fn(() => ({ run: pollerRun }));
    (deps.runRepository.findByUuid as ReturnType<typeof vi.fn>).mockReturnValue({
      uuid: 'existing',
      displayId: 'existing-run',
      status: 'passed',
    });

    const exitCode = await runPoll(defaultArgs, deps);

    expect(exitCode).toBe(0);
    expect(pollerRun).toHaveBeenCalled();
    expect(deps.runRepository.insertIfNoActive).not.toHaveBeenCalled();
  });

  it('returns exit code 0 even when updateStatusByUuid throws on success', async () => {
    const deps = makeDeps();
    (deps.runRepository.updateStatusByUuid as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('database is locked');
    });

    const exitCode = await runPoll(defaultArgs, deps);

    expect(exitCode).toBe(0);
  });

  it('swallows unsubscribe error and still returns exit code', async () => {
    const deps = makeDeps();
    deps.eventBus.subscribe = vi.fn(() => {
      return () => {
        throw new Error('channel closed');
      };
    });

    const exitCode = await runPoll(defaultArgs, deps);

    expect(exitCode).toBe(0);
  });

  it('inserts a run record when none exists (FK guard)', async () => {
    const deps = makeDeps();
    (deps.runRepository.findByUuid as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    await runPoll(defaultArgs, deps);

    expect(deps.runRepository.insertIfNoActive).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'pr_review',
        status: 'running',
        issueNumber: 7,
      }),
    );
  });

  it('skips insert when run record already exists', async () => {
    const deps = makeDeps();
    (deps.runRepository.findByUuid as ReturnType<typeof vi.fn>).mockReturnValue({
      uuid: 'existing',
      displayId: 'existing-run',
      status: 'running',
    });

    await runPoll(defaultArgs, deps);

    expect(deps.runRepository.insertIfNoActive).not.toHaveBeenCalled();
  });

  it('gracefully handles insert race (duplicate)', async () => {
    const deps = makeDeps();
    (deps.runRepository.findByUuid as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ uuid: 'race-uuid', displayId: 'race-run', status: 'running' });
    (deps.runRepository.insertIfNoActive as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('An active run already exists for issue 7');
    });

    const exitCode = await runPoll(defaultArgs, deps);

    expect(exitCode).toBe(0);
  });

  it('re-throws non-active-run insertIfNoActive errors', async () => {
    const deps = makeDeps();
    (deps.runRepository.findByUuid as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (deps.runRepository.insertIfNoActive as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('database is locked');
    });

    await expect(runPoll(defaultArgs, deps)).rejects.toThrow('database is locked');
  });

  it('unsubscribes from eventBus in finally block', async () => {
    const unsubscribe = vi.fn();
    const deps = makeDeps();
    deps.eventBus.subscribe = vi.fn(() => unsubscribe);

    await runPoll(defaultArgs, deps);

    expect(unsubscribe).toHaveBeenCalled();
  });

  it('unsubscribes even when poller throws', async () => {
    const unsubscribe = vi.fn();
    const deps = makeDeps();
    deps.eventBus.subscribe = vi.fn(() => unsubscribe);
    deps.buildPrReviewPoller = vi.fn(() => ({
      run: vi.fn(async () => {
        throw new Error('poller exploded');
      }),
    }));

    await expect(runPoll(defaultArgs, deps)).rejects.toThrow('poller exploded');
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('cleans up result.json files', async () => {
    const deps = makeDeps();
    deps.repoRoot = '/tmp/test-cleanup';
    mockExistsSync.mockImplementation((p: string) => {
      return (
        p === '/tmp/test-cleanup/result.json' || p === '/tmp/test-cleanup/apps/cli/result.json'
      );
    });

    await runPoll(defaultArgs, deps);

    expect(mockExistsSync).toHaveBeenCalledWith('/tmp/test-cleanup/result.json');
    expect(mockExistsSync).toHaveBeenCalledWith('/tmp/test-cleanup/apps/cli/result.json');
    expect(mockUnlinkSync).toHaveBeenCalledWith('/tmp/test-cleanup/result.json');
    expect(mockUnlinkSync).toHaveBeenCalledWith('/tmp/test-cleanup/apps/cli/result.json');
  });

  it('writes startup banner with PID, PR, maxPolls, interval', async () => {
    const deps = makeDeps();
    await runPoll(defaultArgs, deps);
    const writes = (deps.stderr.write as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: [string]) => c[0],
    );
    const banner = writes.find((w: string) => w.includes('PID:'));
    expect(banner).toContain('PR: 42');
    expect(banner).toContain('max_polls: 3');
    expect(banner).toContain('interval: 300s');
  });
});

describe('formatEvent', () => {
  it('formats a structured event as a log line', () => {
    const event: OrchestratorEvent = {
      runId: 'r1',
      phase: 'post-pr-review',
      level: 'info',
      type: 'poll.start',
      message: 'poll.start',
      timestamp: '2026-06-07T14:30:00.000Z',
      metadata: { prNumber: 42 },
    };
    const line = formatEvent(event);
    expect(line).toBe('[14:30:00] [poll.start] poll.start prNumber=42\n');
  });

  it('omits metadata section when empty', () => {
    const event: OrchestratorEvent = {
      runId: 'r1',
      level: 'info',
      type: 'poll.done',
      message: 'Done',
      timestamp: '2026-06-07T09:00:00.000Z',
      metadata: {},
    };
    const line = formatEvent(event);
    expect(line).toBe('[09:00:00] [poll.done] Done\n');
  });
});
