import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildProgram } from '../cli.js';
import * as composeMod from '../compose.js';
import { FairRepositoryScheduler } from '@ai-sdlc/application';

vi.mock('../compose.js');
vi.mock('../worker-drain-loop.js');

const {
  mockServer,
  mockContainer,
  mockRuntimeCatalog,
  registerSpy,
  startDrainSpy,
  getSweepCoordinatorResolve,
  resetSweepCoordinatorMock,
} = vi.hoisted(() => {
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
  let sweepCoordinatorResolve: (() => void) | undefined;
  const mockSweepCoordinator = {
    execute: vi.fn(),
  };
  const resetSweepCoordinatorMock = () => {
    mockSweepCoordinator.execute.mockImplementation(
      () =>
        new Promise<{ results: never[] }>((resolve) => {
          sweepCoordinatorResolve = () => resolve({ results: [] });
        }),
    );
  };
  resetSweepCoordinatorMock();
  const runtimeCatalogCloseSpy = vi.fn().mockResolvedValue(undefined);
  const mockRuntimeCatalog = {
    resolve: vi.fn(),
    resolveEnabled: vi.fn().mockResolvedValue([]),
    resolveAllOperational: vi.fn().mockResolvedValue([]),
    findRun: vi.fn(),
    listRuns: vi.fn().mockResolvedValue({ runs: [], total: 0 }),
    close: runtimeCatalogCloseSpy,
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
    buildRepositorySweepCoordinator: () => mockSweepCoordinator,
    reapOrphanedTestWorkers: {
      execute: vi.fn().mockReturnValue({ reaped: 0, pids: [] }),
    },
    runtimeCatalog: mockRuntimeCatalog,
    schedulerConfig: {
      globalConcurrency: 1,
      pollIntervalMs: 2000,
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
    runtimeCatalogCloseSpy,
    mockRuntimeCatalog,
    getSweepCoordinatorResolve: () => sweepCoordinatorResolve,
    resetSweepCoordinatorMock,
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
    resetSweepCoordinatorMock();
    vi.spyOn(composeMod, 'composeRoot').mockReturnValue(
      mockContainer as unknown as ReturnType<typeof composeMod.composeRoot>,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('serve_uses_shared_scheduler instead of per-repository drain loops', async () => {
    const scheduleOnceSpy = vi
      .spyOn(FairRepositoryScheduler.prototype, 'scheduleOnce')
      .mockResolvedValue({
        admitted: 0,
        cursorId: null,
      });
    const _runSpy = vi.spyOn(FairRepositoryScheduler.prototype, 'run');

    const program = buildProgram({
      isCliTestSuite: true,
      bypassPlanValidation: true,
    });

    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const abortController = new AbortController();
    vi.spyOn(global, 'AbortController').mockImplementation(() => abortController);

    await program.parseAsync(['node', 'orchestrator', 'serve', '--port', '0']);

    const resolveSweep1 = getSweepCoordinatorResolve();
    expect(resolveSweep1).toBeDefined();
    resolveSweep1!();

    await vi.advanceTimersByTimeAsync(100);

    expect(scheduleOnceSpy).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);

    const sigintListeners = process.listeners('SIGINT');
    const shutdownHandler = sigintListeners[sigintListeners.length - 1];
    if (shutdownHandler) {
      await (shutdownHandler as () => Promise<void>)();
    }

    expect(registerSpy).not.toHaveBeenCalled();
    expect(startDrainSpy).not.toHaveBeenCalled();
  });

  it('signal_stops_new_admission and closes the runtime catalog', async () => {
    const scheduleOnceSpy = vi
      .spyOn(FairRepositoryScheduler.prototype, 'scheduleOnce')
      .mockResolvedValue({
        admitted: 0,
        cursorId: null,
      });
    vi.spyOn(FairRepositoryScheduler.prototype, 'run');

    const program = buildProgram({
      isCliTestSuite: true,
      bypassPlanValidation: true,
    });

    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const abortController = new AbortController();
    vi.spyOn(global, 'AbortController').mockImplementation(() => abortController);

    await program.parseAsync(['node', 'orchestrator', 'serve', '--port', '0']);

    const resolveSweep2 = getSweepCoordinatorResolve();
    expect(resolveSweep2).toBeDefined();
    resolveSweep2!();

    await vi.advanceTimersByTimeAsync(100);

    const sigintListeners = process.listeners('SIGINT');
    const shutdownHandler = sigintListeners[sigintListeners.length - 1];
    if (shutdownHandler) {
      await (shutdownHandler as () => Promise<void>)();
    }

    expect(scheduleOnceSpy).toHaveBeenCalled();
    expect(mockRuntimeCatalog.close).toHaveBeenCalled();
  });

  it('startup recovery is an admission barrier: scheduler does not start until initial sweep completes', async () => {
    const _scheduleOnceSpy = vi
      .spyOn(FairRepositoryScheduler.prototype, 'scheduleOnce')
      .mockResolvedValue({
        admitted: 0,
        cursorId: null,
      });
    const runSpy = vi.spyOn(FairRepositoryScheduler.prototype, 'run');

    const program = buildProgram({
      isCliTestSuite: true,
      bypassPlanValidation: true,
    });

    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const abortController = new AbortController();
    vi.spyOn(global, 'AbortController').mockImplementation(() => abortController);

    await program.parseAsync(['node', 'orchestrator', 'serve', '--port', '0']);

    // Advance timers to let async operations run, but the sweep hasn't resolved yet
    await vi.advanceTimersByTimeAsync(100);

    // The scheduler's run() should NOT have been called yet because the
    // initial sweep must complete first (it's an admission barrier).
    // With fire-and-forget behavior this would have already started.
    expect(runSpy).not.toHaveBeenCalled();

    // Now resolve the initial sweep
    const resolveSweep = getSweepCoordinatorResolve();
    expect(resolveSweep).toBeDefined();
    resolveSweep!();

    // Now advance time again - the scheduler should start
    await vi.advanceTimersByTimeAsync(100);
    expect(runSpy).toHaveBeenCalled();

    const sigintListeners = process.listeners('SIGINT');
    const shutdownHandler = sigintListeners[sigintListeners.length - 1];
    if (shutdownHandler) {
      await (shutdownHandler as () => Promise<void>)();
    }
  });

  it('startup waits for failed repository result before admission', async () => {
    const _scheduleOnceSpy = vi
      .spyOn(FairRepositoryScheduler.prototype, 'scheduleOnce')
      .mockResolvedValue({
        admitted: 0,
        cursorId: null,
      });
    const runSpy = vi.spyOn(FairRepositoryScheduler.prototype, 'run');

    let sweepResolve: (() => void) | undefined;
    const mockSweepCoordinatorWithError = {
      execute: vi.fn().mockImplementation(
        () =>
          new Promise<{
            results: Array<{
              fullName: string;
              error?: string;
              orphaned?: {
                enqueued: number;
                skippedLeaseConflict: number;
                enqueueErrors: string[];
              };
              waiting?: { reactivated: number; errors: string[]; enqueueErrors: string[] };
            }>;
          }>((resolve) => {
            sweepResolve = () =>
              resolve({
                results: [
                  {
                    fullName: 'owner/repo',
                    error: 'connection refused',
                    orphaned: { enqueued: 0, skippedLeaseConflict: 0, enqueueErrors: [] },
                    waiting: { reactivated: 0, errors: [], enqueueErrors: [] },
                  },
                ],
              });
          }),
      ),
    };
    const localMockContainer = {
      ...mockContainer,
      buildRepositorySweepCoordinator: () => mockSweepCoordinatorWithError,
    };
    vi.spyOn(composeMod, 'composeRoot').mockReturnValue(
      localMockContainer as unknown as ReturnType<typeof composeMod.composeRoot>,
    );

    const program = buildProgram({
      isCliTestSuite: true,
      bypassPlanValidation: true,
    });

    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const abortController = new AbortController();
    vi.spyOn(global, 'AbortController').mockImplementation(() => abortController);

    await program.parseAsync(['node', 'orchestrator', 'serve', '--port', '0']);

    // Advance timers to let async operations run, but the sweep hasn't resolved yet
    await vi.advanceTimersByTimeAsync(100);

    // The scheduler's run() should NOT have been called yet because the
    // initial sweep must complete first (it's an admission barrier).
    expect(runSpy).not.toHaveBeenCalled();

    // Now resolve the initial sweep - even though it has an error
    expect(sweepResolve).toBeDefined();
    sweepResolve!();

    // Now advance time again - the scheduler should start after sweep completes
    await vi.advanceTimersByTimeAsync(100);
    expect(runSpy).toHaveBeenCalled();

    const sigintListeners = process.listeners('SIGINT');
    const shutdownHandler = sigintListeners[sigintListeners.length - 1];
    if (shutdownHandler) {
      await (shutdownHandler as () => Promise<void>)();
    }
  });

  it('periodic pass uses the same coordinator without overlapping', async () => {
    const _runSpy = vi.spyOn(FairRepositoryScheduler.prototype, 'run');
    vi.spyOn(FairRepositoryScheduler.prototype, 'scheduleOnce').mockResolvedValue({
      admitted: 0,
      cursorId: null,
    });

    let executeCallCount = 0;
    let currentResolve: (() => void) | undefined;
    const mockSweepCoordinator = {
      execute: vi.fn().mockImplementation(() => {
        executeCallCount++;
        return new Promise<{ results: never[] }>((resolve) => {
          currentResolve = () => resolve({ results: [] });
        });
      }),
    };
    const localMockContainer = {
      ...mockContainer,
      buildRepositorySweepCoordinator: () => mockSweepCoordinator,
    };
    vi.spyOn(composeMod, 'composeRoot').mockReturnValue(
      localMockContainer as unknown as ReturnType<typeof composeMod.composeRoot>,
    );

    const program = buildProgram({
      isCliTestSuite: true,
      bypassPlanValidation: true,
    });

    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const abortController = new AbortController();
    vi.spyOn(global, 'AbortController').mockImplementation(() => abortController);

    await program.parseAsync(['node', 'orchestrator', 'serve', '--port', '0']);

    // Resolve initial sweep
    currentResolve!();
    await vi.advanceTimersByTimeAsync(100);

    // Reset call count after initial sweep
    executeCallCount = 0;

    // Advance timers past the periodic sweep interval (serveSweepIntervalSeconds=60 -> 60000ms).
    // Wait for the first periodic sweep to start.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(executeCallCount).toBe(1);

    // Even if we advance past a second interval, the second call shouldn't happen while
    // the first periodic sweep is still running (its promise is never resolved in this test).
    // This verifies the isRunning guard prevents overlapping sweeps.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(executeCallCount).toBe(1);

    const sigintListeners = process.listeners('SIGINT');
    const shutdownHandler = sigintListeners[sigintListeners.length - 1];
    if (shutdownHandler) {
      await (shutdownHandler as () => Promise<void>)();
    }
  });
});
