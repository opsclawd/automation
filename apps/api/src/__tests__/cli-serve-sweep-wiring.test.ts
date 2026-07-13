import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildProgram } from '../cli.js';
import * as composeMod from '../compose.js';

vi.mock('../compose.js');
vi.mock('../worker-drain-loop.js');

const { mockServer, mockContainer, mockSweeper, mockOrphanSweeper, registerSpy, startDrainSpy } =
  vi.hoisted(() => {
    const registerSpy = vi.fn();
    const heartbeatSpy = vi.fn();
    const startDrainSpy = vi.fn().mockReturnValue({ stop: vi.fn() });
    const mockSweeper = {
      execute: vi.fn().mockResolvedValue({
        scanned: 0,
        reactivated: 0,
        enqueued: 0,
        skippedLeaseConflict: 0,
        timedOut: 0,
        passedOnMergedPr: 0,
        cancelledOnClosedPr: 0,
        stayedReady: 0,
        skipped: 0,
        errors: [],
        enqueueErrors: [],
      }),
    };
    const mockOrphanSweeper = {
      execute: vi.fn().mockResolvedValue({
        scanned: 0,
        enqueued: 0,
        skippedLeaseConflict: 0,
        skippedAlreadyQueued: 0,
        enqueueErrors: [],
      }),
    };
    const mockContainer = {
      workerRegistry: {
        register: registerSpy,
        deregister: vi.fn(),
        heartbeat: heartbeatSpy,
      },
      workerLoopDeps: () => ({
        mock: 'deps',
      }),
      listRepositories: {
        execute: vi.fn().mockReturnValue([{ id: 'owner/repo', fullName: 'owner/repo' }]),
      },
      runRepository: {
        findActiveRuns: vi.fn().mockReturnValue([]),
      },
      serveSweepIntervalSeconds: 60,
      buildWaitingRunsSweeper: () => mockSweeper,
      buildOrphanedRunsSweeper: () => mockOrphanSweeper,
      reapOrphanedTestWorkers: {
        execute: vi.fn().mockReturnValue({ reaped: 0, pids: [] }),
      },
    };
    const mockServer = {
      address: { port: 12345 },
      stop: vi.fn().mockResolvedValue(undefined),
    };
    return {
      mockServer,
      mockContainer,
      mockSweeper,
      mockOrphanSweeper,
      registerSpy,
      heartbeatSpy,
      startDrainSpy,
    };
  });

vi.mock('../compose.js', () => ({
  composeRoot: vi.fn().mockImplementation(() => mockContainer),
}));
vi.mock('../worker-drain-loop.js', () => ({
  startWorkerDrainLoop: vi.fn().mockImplementation((...args) => startDrainSpy(...args)),
}));
vi.mock('../server.js', () => ({
  startServer: async () => mockServer,
}));

describe('cli serve sweep and worker wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(composeMod, 'composeRoot').mockReturnValue(
      mockContainer as unknown as ReturnType<typeof composeMod.composeRoot>,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs initial sweep and schedules periodic sweep if interval > 0', async () => {
    const program = buildProgram({
      isCliTestSuite: true,
      bypassPlanValidation: true,
    });

    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    // Run the serve command
    await program.parseAsync(['node', 'orchestrator', 'serve', '--port', '0']);

    // Expect composeRoot was called with runStartupSweeps: false
    expect(composeMod.composeRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        runStartupSweeps: false,
      }),
    );

    // Expect worker registration occurred
    expect(registerSpy).toHaveBeenCalledTimes(1);

    // Expect drain loop was started
    expect(startDrainSpy).toHaveBeenCalledTimes(1);

    // Expect initial sweep was triggered (both waiting + orphan sweepers)
    expect(mockSweeper.execute).toHaveBeenCalledTimes(1);
    expect(mockOrphanSweeper.execute).toHaveBeenCalledTimes(1);

    // Advance timer to trigger next sweep interval
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockSweeper.execute).toHaveBeenCalledTimes(2);
    expect(mockOrphanSweeper.execute).toHaveBeenCalledTimes(2);

    // Call shutdown to verify cleanup
    // Find the SIGINT handler
    const sigintListeners = process.listeners('SIGINT');
    const shutdownHandler = sigintListeners[sigintListeners.length - 1];
    if (shutdownHandler) {
      await (shutdownHandler as () => Promise<void>)();
      expect(mockContainer.workerRegistry.deregister).toHaveBeenCalled();
    }
  });
});
