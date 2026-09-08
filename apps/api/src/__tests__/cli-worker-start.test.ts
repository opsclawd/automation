import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildProgram } from '../cli.js';
import * as composeMod from '../compose.js';
import { FairRepositoryScheduler } from '@ai-sdlc/application';

vi.mock('../compose.js');

const {
  mockServer,
  mockContainer,
  mockRuntimeCatalog,
  mockSweepCoordinator,
  registerSpy,
  startDrainSpy,
  runNotificationDrainSpy,
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
  const runNotificationDrainSpy = vi.fn().mockResolvedValue(undefined);
  const mockRunNotification = {
    notify: vi.fn().mockResolvedValue(undefined),
    drain: runNotificationDrainSpy,
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
    runNotification: mockRunNotification,
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
    mockSweepCoordinator,
    runNotificationDrainSpy,
  };
});

vi.mock('../compose.js', () => ({
  composeRoot: vi.fn().mockImplementation(() => mockContainer),
}));
vi.mock('../server.js', () => ({
  startServer: async () => mockServer,
}));

describe('cli worker start', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSweepCoordinator.execute.mockResolvedValue({ results: [] });
    vi.spyOn(composeMod, 'composeRoot').mockReturnValue(
      mockContainer as unknown as ReturnType<typeof composeMod.composeRoot>,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('worker_start_uses_shared_scheduler with config defaults', async () => {
    const _buildFairSchedulerSpy = vi.spyOn(FairRepositoryScheduler.prototype, 'run');
    vi.spyOn(FairRepositoryScheduler.prototype, 'scheduleOnce').mockResolvedValue({
      admitted: 0,
      cursorId: null,
    });

    const program = buildProgram({
      isCliTestSuite: true,
      bypassPlanValidation: true,
    });

    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const abortController = new AbortController();
    vi.spyOn(global, 'AbortController').mockImplementation(() => abortController);

    const promise = program.parseAsync(['node', 'orchestrator', 'worker', 'start']);

    await vi.advanceTimersByTimeAsync(100);

    abortController.abort();

    await promise;

    expect(FairRepositoryScheduler.prototype.run).toHaveBeenCalled();
  });

  it('worker_start_cli_overrides_config with validated positive integers', async () => {
    const _buildFairSchedulerSpy = vi.spyOn(FairRepositoryScheduler.prototype, 'run');
    vi.spyOn(FairRepositoryScheduler.prototype, 'scheduleOnce').mockResolvedValue({
      admitted: 0,
      cursorId: null,
    });

    const program = buildProgram({
      isCliTestSuite: true,
      bypassPlanValidation: true,
    });

    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const abortController = new AbortController();
    vi.spyOn(global, 'AbortController').mockImplementation(() => abortController);

    const promise = program.parseAsync([
      'node',
      'orchestrator',
      'worker',
      'start',
      '--global-concurrency',
      '5',
      '--poll-interval-ms',
      '5000',
    ]);

    await vi.advanceTimersByTimeAsync(100);

    abortController.abort();

    await promise;

    expect(FairRepositoryScheduler.prototype.run).toHaveBeenCalled();
  });

  it('worker start drains runNotification on SIGINT shutdown before exiting', async () => {
    runNotificationDrainSpy.mockClear();
    const _buildFairSchedulerSpy = vi.spyOn(FairRepositoryScheduler.prototype, 'run');
    vi.spyOn(FairRepositoryScheduler.prototype, 'scheduleOnce').mockResolvedValue({
      admitted: 0,
      cursorId: null,
    });

    const program = buildProgram({
      isCliTestSuite: true,
      bypassPlanValidation: true,
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const abortController = new AbortController();
    vi.spyOn(global, 'AbortController').mockImplementation(() => abortController);

    const promise = program.parseAsync(['node', 'orchestrator', 'worker', 'start']);
    await vi.advanceTimersByTimeAsync(100);

    const sigintListeners = process.listeners('SIGINT');
    const shutdownHandler = sigintListeners[sigintListeners.length - 1];
    expect(shutdownHandler).toBeDefined();
    await (shutdownHandler as () => Promise<void>)();

    expect(runNotificationDrainSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);

    abortController.abort();
    await promise;
  });

  it('worker start drains runNotification on scheduler error before exiting', async () => {
    runNotificationDrainSpy.mockClear();
    vi.spyOn(FairRepositoryScheduler.prototype, 'run').mockRejectedValue(
      new Error('scheduler failed'),
    );

    const program = buildProgram({
      isCliTestSuite: true,
      bypassPlanValidation: true,
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const abortController = new AbortController();
    vi.spyOn(global, 'AbortController').mockImplementation(() => abortController);

    await program.parseAsync(['node', 'orchestrator', 'worker', 'start']);
    await vi.advanceTimersByTimeAsync(100);

    expect(runNotificationDrainSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});

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
    const _buildFairSchedulerSpy = vi.spyOn(FairRepositoryScheduler.prototype, 'run');
    vi.spyOn(FairRepositoryScheduler.prototype, 'scheduleOnce').mockResolvedValue({
      admitted: 0,
      cursorId: null,
    });

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

    expect(registerSpy).not.toHaveBeenCalled();
    expect(startDrainSpy).not.toHaveBeenCalled();
  });

  it('signal_stops_new_admission and closes the runtime catalog', async () => {
    const _buildFairSchedulerSpy = vi.spyOn(FairRepositoryScheduler.prototype, 'run');
    vi.spyOn(FairRepositoryScheduler.prototype, 'scheduleOnce').mockResolvedValue({
      admitted: 0,
      cursorId: null,
    });

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

    expect(mockRuntimeCatalog.close).toHaveBeenCalled();
  });

  it('standalone_and_embedded_modes_are_not_started_together', async () => {
    const _buildFairSchedulerSpy = vi.spyOn(FairRepositoryScheduler.prototype, 'run');
    vi.spyOn(FairRepositoryScheduler.prototype, 'scheduleOnce').mockResolvedValue({
      admitted: 0,
      cursorId: null,
    });

    const program = buildProgram({
      isCliTestSuite: true,
      bypassPlanValidation: true,
    });

    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const abortController = new AbortController();
    vi.spyOn(global, 'AbortController').mockImplementation(() => abortController);

    const promise = program.parseAsync(['node', 'orchestrator', 'worker', 'start']);

    await vi.advanceTimersByTimeAsync(100);

    abortController.abort();

    await promise;

    await program.parseAsync(['node', 'orchestrator', 'serve', '--port', '0']);

    await vi.advanceTimersByTimeAsync(100);

    const sigintListeners = process.listeners('SIGINT');
    const shutdownHandler = sigintListeners[sigintListeners.length - 1];
    if (shutdownHandler) {
      await (shutdownHandler as () => Promise<void>)();
    }

    expect(registerSpy).not.toHaveBeenCalled();
  });

  it('serve drains runNotification on SIGINT shutdown before exiting', async () => {
    runNotificationDrainSpy.mockClear();
    const _buildFairSchedulerSpy = vi.spyOn(FairRepositoryScheduler.prototype, 'run');
    vi.spyOn(FairRepositoryScheduler.prototype, 'scheduleOnce').mockResolvedValue({
      admitted: 0,
      cursorId: null,
    });

    const program = buildProgram({
      isCliTestSuite: true,
      bypassPlanValidation: true,
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const abortController = new AbortController();
    vi.spyOn(global, 'AbortController').mockImplementation(() => abortController);

    await program.parseAsync(['node', 'orchestrator', 'serve', '--port', '0']);
    await vi.advanceTimersByTimeAsync(100);

    const sigintListeners = process.listeners('SIGINT');
    const shutdownHandler = sigintListeners[sigintListeners.length - 1];
    expect(shutdownHandler).toBeDefined();
    await (shutdownHandler as () => Promise<void>)();

    expect(runNotificationDrainSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('serve awaits in-flight initial repository sweep before draining notifications on shutdown', async () => {
    let sweepResolved = false;
    let resolveSweep: (() => void) | undefined;
    const sweepPromise = new Promise<{ results: never[] }>((resolve) => {
      resolveSweep = () => {
        sweepResolved = true;
        resolve({ results: [] });
      };
    });
    mockSweepCoordinator.execute.mockReturnValueOnce(sweepPromise);

    const callOrder: string[] = [];
    runNotificationDrainSpy.mockClear();
    runNotificationDrainSpy.mockImplementation(async () => {
      callOrder.push(sweepResolved ? 'drain-after-sweep' : 'drain-before-sweep');
    });

    const program = buildProgram({
      isCliTestSuite: true,
      bypassPlanValidation: true,
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const abortController = new AbortController();
    vi.spyOn(global, 'AbortController').mockImplementation(() => abortController);

    await program.parseAsync(['node', 'orchestrator', 'serve', '--port', '0']);
    await vi.advanceTimersByTimeAsync(50);

    const sigintListeners = process.listeners('SIGINT');
    const shutdownHandler = sigintListeners[sigintListeners.length - 1];
    expect(shutdownHandler).toBeDefined();

    // Trigger shutdown while sweep is still in flight
    const shutdownPromise = (shutdownHandler as () => Promise<void>)();

    // While sweep is unresolved, drain should not have happened yet
    expect(runNotificationDrainSpy).not.toHaveBeenCalled();

    // Resolve initial sweep
    resolveSweep!();
    await vi.advanceTimersByTimeAsync(50);
    await shutdownPromise;

    expect(runNotificationDrainSpy).toHaveBeenCalled();
    expect(callOrder).toEqual(['drain-after-sweep']);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('worker start awaits in-flight initial repository sweep before draining notifications on shutdown', async () => {
    let sweepResolved = false;
    let resolveSweep: (() => void) | undefined;
    const sweepPromise = new Promise<{ results: never[] }>((resolve) => {
      resolveSweep = () => {
        sweepResolved = true;
        resolve({ results: [] });
      };
    });
    mockSweepCoordinator.execute.mockReturnValueOnce(sweepPromise);

    const callOrder: string[] = [];
    runNotificationDrainSpy.mockClear();
    runNotificationDrainSpy.mockImplementation(async () => {
      callOrder.push(sweepResolved ? 'drain-after-sweep' : 'drain-before-sweep');
    });

    const program = buildProgram({
      isCliTestSuite: true,
      bypassPlanValidation: true,
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const abortController = new AbortController();
    vi.spyOn(global, 'AbortController').mockImplementation(() => abortController);

    const workerStartPromise = program.parseAsync(['node', 'orchestrator', 'worker', 'start']);
    await vi.advanceTimersByTimeAsync(50);

    const sigintListeners = process.listeners('SIGINT');
    const shutdownHandler = sigintListeners[sigintListeners.length - 1];
    expect(shutdownHandler).toBeDefined();

    // Trigger shutdown while sweep is still in flight
    const shutdownPromise = (shutdownHandler as () => Promise<void>)();

    // While sweep is unresolved, drain should not have happened yet
    expect(runNotificationDrainSpy).not.toHaveBeenCalled();

    // Resolve initial sweep
    resolveSweep!();
    await vi.advanceTimersByTimeAsync(50);
    await shutdownPromise;

    expect(runNotificationDrainSpy).toHaveBeenCalled();
    expect(callOrder).toEqual(['drain-after-sweep']);
    expect(exitSpy).toHaveBeenCalledWith(0);

    abortController.abort();
    await workerStartPromise;
  });
});
