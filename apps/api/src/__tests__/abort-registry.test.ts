import { describe, expect, it, vi } from 'vitest';
import { RunId } from '@ai-sdlc/domain';
import { composeRoot } from '../compose.js';

describe('AbortRegistry and runAbort', () => {
  it('returns not_found when aborting an unregistered runId', async () => {
    const c = composeRoot({
      repoRoot: process.cwd(),
      scriptPath: 'scripts/legacy/ai-run-issue-v2',
      runStartupSweeps: false,
    });
    const res = await c.runAbort.abort(RunId('non-existent-run'));
    expect(res).toEqual({ status: 'not_found' });
  });

  it('returns exited when registered done promise resolves', async () => {
    const c = composeRoot({
      repoRoot: process.cwd(),
      scriptPath: 'scripts/legacy/ai-run-issue-v2',
      runStartupSweeps: false,
    });
    const controller = new AbortController();
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    c.runAbort.register(RunId('test-run-1'), controller, done);

    const abortPromise = c.runAbort.abort(RunId('test-run-1'));
    expect(controller.signal.aborted).toBe(true);

    resolveDone();
    const res = await abortPromise;
    expect(res).toEqual({ status: 'exited' });
  });

  it('returns timed_out when registered done promise does not resolve within timeout', async () => {
    vi.useFakeTimers();
    try {
      const c = composeRoot({
        repoRoot: process.cwd(),
        scriptPath: 'scripts/legacy/ai-run-issue-v2',
        runStartupSweeps: false,
      });
      const controller = new AbortController();
      const done = new Promise<void>(() => {}); // Never resolves

      c.runAbort.register(RunId('hanging-run'), controller, done);

      const abortPromise = c.runAbort.abort(RunId('hanging-run'));
      expect(controller.signal.aborted).toBe(true);

      await vi.advanceTimersByTimeAsync(30_000);
      const res = await abortPromise;
      expect(res).toEqual({ status: 'timed_out' });
    } finally {
      vi.useRealTimers();
    }
  });
});
