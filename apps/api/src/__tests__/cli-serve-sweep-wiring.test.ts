import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildProgram } from '../cli.js';
import * as composeMod from '../compose.js';
import { FairRepositoryScheduler } from '@ai-sdlc/application';

vi.mock('../compose.js');
vi.mock('../worker-drain-loop.js');

const { mockServer, mockContainer, mockRuntimeCatalog, registerSpy, startDrainSpy } = vi.hoisted(
  () => {
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
    const mockSweepCoordinator = {
      execute: vi.fn().mockResolvedValue({
        results: [],
      }),
    };
    const runtimeCatalogCloseSpy = vi.fn().mockResolvedValue(undefined);
    const mockRuntimeCatalog = {
      resolve: vi.fn(),
      resolveEnabled: vi.fn().mockResolvedValue([]),
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
    };
  },
);

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

    await vi.advanceTimersByTimeAsync(100);

    const sigintListeners = process.listeners('SIGINT');
    const shutdownHandler = sigintListeners[sigintListeners.length - 1];
    if (shutdownHandler) {
      await (shutdownHandler as () => Promise<void>)();
    }

    expect(scheduleOnceSpy).toHaveBeenCalled();
    expect(mockRuntimeCatalog.close).toHaveBeenCalled();
  });
});
