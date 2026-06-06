import { describe, it, expect } from 'vitest';
import { parsePollArgs, exitCodeForTerminalState } from '../run-pr-poll.js';
import type { PollerTerminalState } from '@ai-sdlc/application';

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

  it('defaults maxPolls=3 and pollIntervalSeconds=300 when omitted', () => {
    const r = parsePollArgs(['--pr', '5', '--repo', 'o/r', '--cwd', '/w']);
    expect(r.maxPolls).toBe(3);
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
});

describe('exitCodeForTerminalState', () => {
  it('maps all_resolved -> 0', () => {
    expect(exitCodeForTerminalState('all_resolved' as PollerTerminalState)).toBe(0);
  });
  it('maps max_polls_reached -> 0 (resting, not a failure)', () => {
    expect(exitCodeForTerminalState('max_polls_reached' as PollerTerminalState)).toBe(0);
  });
  it('maps blocked -> 1', () => {
    expect(exitCodeForTerminalState('blocked' as PollerTerminalState)).toBe(1);
  });
  it('maps timed_out -> 2', () => {
    expect(exitCodeForTerminalState('timed_out' as PollerTerminalState)).toBe(2);
  });
  it('maps unknown state -> 3', () => {
    expect(exitCodeForTerminalState('something_else' as PollerTerminalState)).toBe(3);
  });
});
