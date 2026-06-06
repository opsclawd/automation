// apps/cli/src/__tests__/run-pr-poll.e2e.test.ts
import { describe, it, expect } from 'vitest';
import { parsePollArgs, exitCodeForTerminalState } from '../run-pr-poll.js';
import type { PollerTerminalState } from '@ai-sdlc/application';

describe('run-pr-poll CLI contract', () => {
  it('parses a no-comment poll and maps all_resolved to exit 0', () => {
    const args = parsePollArgs(['--pr', '5', '--repo', 'o/r', '--cwd', process.cwd()]);
    expect(args.prNumber).toBe(5);
    expect(args.maxPolls).toBe(3);
    expect(args.pollIntervalSeconds).toBe(300);
    expect(exitCodeForTerminalState('all_resolved' as PollerTerminalState)).toBe(0);
  });

  it('maps blocked to exit 1 and timed_out to exit 2', () => {
    expect(exitCodeForTerminalState('blocked' as PollerTerminalState)).toBe(1);
    expect(exitCodeForTerminalState('timed_out' as PollerTerminalState)).toBe(2);
  });
});
