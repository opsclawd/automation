import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RepositoryId } from '@ai-sdlc/domain';
import { FakeRunNotification } from '@ai-sdlc/application/test-doubles';
import { WebhookRunNotificationAdapter } from '@ai-sdlc/infrastructure';
import { installSignalHandlers, reconcileStrandedRun, drainAndExit } from '../cli.js';
import type { Container } from '../compose.js';

const TEST_REPO_ID = RepositoryId('acme/widgets');

function makeRunRepositorySpies() {
  return {
    findByIssueNumber: vi.fn().mockReturnValue({ pid: process.pid }),
    updateStatusByIssueNumber: vi.fn().mockReturnValue(true),
    atomicUpdateByUuid: vi.fn().mockReturnValue(true),
    update: vi.fn(),
    findByUuid: vi.fn(),
    insertIfNoActive: vi.fn(),
    findActiveRuns: vi.fn().mockReturnValue([]),
    updateStatusByUuid: vi.fn().mockReturnValue(true),
  };
}

describe('CLI terminal persistence', () => {
  let exitMock: ReturnType<typeof vi.fn>;
  let consoleDebugSpy: ReturnType<typeof vi.fn>;
  let processOnSpy: ReturnType<typeof vi.fn>;
  let processOffSpy: ReturnType<typeof vi.fn>;
  let registeredHandlers: Map<string, Set<(...args: unknown[]) => void>>;

  beforeEach(() => {
    exitMock = vi.fn();
    consoleDebugSpy = vi.fn();
    processOnSpy = vi.fn();
    processOffSpy = vi.fn();
    registeredHandlers = new Map();

    vi.stubGlobal('process', {
      ...process,
      exit: exitMock,
      on: (event: string, handler: (...args: unknown[]) => void) => {
        if (!registeredHandlers.has(event)) {
          registeredHandlers.set(event, new Set());
        }
        registeredHandlers.get(event)!.add(handler);
        processOnSpy(event, handler);
      },
      off: (event: string, handler: (...args: unknown[]) => void) => {
        registeredHandlers.get(event)?.delete(handler);
        processOffSpy(event, handler);
      },
      emit: (event: string, ...args: unknown[]) => {
        const handlers = registeredHandlers.get(event);
        if (handlers) {
          for (const handler of handlers) {
            handler(...args);
          }
        }
      },
      pid: 12345,
    });

    vi.stubGlobal('console', {
      ...console,
      debug: consoleDebugSpy,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('signal cleanup logs before and after a successful status write', () => {
    it('logs before and after a successful status write in installSignalHandlers', async () => {
      const runRepository = makeRunRepositorySpies();

      const handlers = installSignalHandlers(runRepository, TEST_REPO_ID, 42);

      const debugCallsBefore = consoleDebugSpy.mock.calls.filter(
        (call) => call[0] && String(call[0]).includes('terminal status write'),
      ).length;

      expect(debugCallsBefore).toBe(0);

      handlers.remove();
    });

    it('logs before and after atomicUpdateByUuid in TS run signal handler', async () => {
      const runRepository = makeRunRepositorySpies();

      const handlers = installSignalHandlers(runRepository, TEST_REPO_ID, 42);

      process.emit('SIGINT', 'SIGINT');

      const debugCalls = consoleDebugSpy.mock.calls.filter(
        (call) => call[0] && String(call[0]).includes('terminal status write'),
      );

      expect(debugCalls.length).toBe(2);
      expect(String(debugCalls[0][0])).toContain('starting');
      expect(String(debugCalls[1][0])).toContain('completed');

      handlers.remove();
    });
  });

  describe('signal cleanup reports applied=false without claiming success', () => {
    it('reports applied=false when updateStatusByIssueNumber returns false', async () => {
      const runRepository = makeRunRepositorySpies();
      runRepository.updateStatusByIssueNumber.mockReturnValue(false);

      const debugCalls: string[] = [];
      const mockDebug = (msg: string) => {
        debugCalls.push(msg);
        consoleDebugSpy(msg);
      };

      mockDebug('terminal status write starting');
      const applied = runRepository.updateStatusByIssueNumber(TEST_REPO_ID, 42, {
        status: 'cancelled',
        completedAt: new Date(),
        failureReason: 'interrupted by SIGINT',
      });
      mockDebug(`terminal status write completed, applied=${applied}`);

      expect(applied).toBe(false);

      const hasFalseMarker = debugCalls.some(
        (c) => c.includes('applied=false') || c.includes('applied=false'),
      );
      const hasSuccessWithFalse = debugCalls.some(
        (c) => c.includes('success') && c.includes('applied=false'),
      );

      expect(hasFalseMarker).toBe(true);
      expect(hasSuccessWithFalse).toBe(false);
    });

    it('reports applied=false when atomicUpdateByUuid returns false', async () => {
      const runRepository = makeRunRepositorySpies();
      runRepository.atomicUpdateByUuid.mockReturnValue(false);

      const debugCalls: string[] = [];
      const mockDebug = (msg: string) => {
        debugCalls.push(msg);
        consoleDebugSpy(msg);
      };

      mockDebug('terminal status write starting');
      const applied = runRepository.atomicUpdateByUuid(
        'run-1',
        {
          status: 'cancelled',
          completedAt: new Date(),
          failureReason: 'interrupted by SIGTERM',
        },
        'running',
      );
      mockDebug(`terminal status write completed, applied=${applied}`);

      expect(applied).toBe(false);

      const hasFalseMarker = debugCalls.some((c) => c.includes('applied=false'));
      const hasSuccessWithFalse = debugCalls.some(
        (c) => c.includes('success') && c.includes('applied=false'),
      );

      expect(hasFalseMarker).toBe(true);
      expect(hasSuccessWithFalse).toBe(false);
    });
  });

  describe('worker-loop fallback before-after markers', () => {
    it('worker-loop fallback logs before and after converting stranded running row', async () => {
      const runRepository = makeRunRepositorySpies();
      runRepository.atomicUpdateByUuid.mockReturnValue(true);
      const run = {
        uuid: 'run-1',
        repoId: TEST_REPO_ID,
        issueNumber: 42,
        displayId: 'run-1',
      };

      const applied = reconcileStrandedRun(
        run,
        runRepository,
        'worker loop terminated without finalizing run',
      );

      expect(applied).toBe(true);

      const updateCalls = consoleDebugSpy.mock.calls.filter((c) =>
        String(c[0]).includes('terminal status write'),
      );
      expect(updateCalls.length).toBe(2);
      expect(String(updateCalls[0][0])).toContain('starting');
      expect(String(updateCalls[1][0])).toContain('completed');
    });

    it('dispatches notification when worker-loop fallback applies terminal status', async () => {
      const fakeNotification = new FakeRunNotification();
      const runRepository = makeRunRepositorySpies();
      runRepository.atomicUpdateByUuid.mockReturnValue(true);
      const run = {
        uuid: 'test-uuid',
        repoId: TEST_REPO_ID,
        issueNumber: 42,
        displayId: 'run-1',
      };

      const applied = reconcileStrandedRun(
        run,
        runRepository,
        'worker loop terminated without finalizing run',
        fakeNotification,
      );

      expect(applied).toBe(true);
      expect(fakeNotification.events).toHaveLength(1);
      expect(fakeNotification.events[0]).toEqual({
        status: 'failed',
        repoId: TEST_REPO_ID,
        issueNumber: 42,
        displayId: 'run-1',
        failureReason: 'worker loop terminated without finalizing run',
      });
    });

    it('does not dispatch notification when worker-loop fallback CAS returns false', async () => {
      const fakeNotification = new FakeRunNotification();
      const runRepository = makeRunRepositorySpies();
      runRepository.atomicUpdateByUuid.mockReturnValue(false);
      const run = {
        uuid: 'test-uuid',
        repoId: TEST_REPO_ID,
        issueNumber: 42,
        displayId: 'run-1',
      };

      const applied = reconcileStrandedRun(
        run,
        runRepository,
        'worker loop terminated without finalizing run',
        fakeNotification,
      );

      expect(applied).toBe(false);
      expect(fakeNotification.events).toHaveLength(0);
    });

    it('reconciles run on error catch block fallback and dispatches notification', async () => {
      const fakeNotification = new FakeRunNotification();
      const runRepository = makeRunRepositorySpies();
      runRepository.atomicUpdateByUuid.mockReturnValue(true);
      const run = {
        uuid: 'test-uuid-error',
        repoId: TEST_REPO_ID,
        issueNumber: 42,
        displayId: 'run-1',
      };

      const applied = reconcileStrandedRun(
        run,
        runRepository,
        'fatal runtime error',
        fakeNotification,
      );

      expect(applied).toBe(true);
      expect(fakeNotification.events).toHaveLength(1);
      expect(fakeNotification.events[0]).toEqual({
        status: 'failed',
        repoId: TEST_REPO_ID,
        issueNumber: 42,
        displayId: 'run-1',
        failureReason: 'fatal runtime error',
      });
    });

    it('handles atomicUpdateByUuid exceptions gracefully without throwing', async () => {
      const fakeNotification = new FakeRunNotification();
      const runRepository = makeRunRepositorySpies();
      runRepository.atomicUpdateByUuid.mockImplementation(() => {
        throw new Error('disk failure');
      });
      const run = {
        uuid: 'test-uuid-err',
        repoId: TEST_REPO_ID,
        issueNumber: 42,
        displayId: 'run-1',
      };

      const applied = reconcileStrandedRun(
        run,
        runRepository,
        'worker loop terminated without finalizing run',
        fakeNotification,
      );

      expect(applied).toBe(false);
      expect(fakeNotification.events).toHaveLength(0);
    });
  });

  describe('CLI process exit notification drain lifecycle', () => {
    it('drains pending notification fetch before process.exit', async () => {
      let resolveFetch!: (val: Response) => void;
      const fetchPromise = new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
      const fetchImpl = vi.fn().mockReturnValue(fetchPromise);
      const adapter = new WebhookRunNotificationAdapter(
        'https://example.com',
        undefined,
        fetchImpl,
      );

      // launch notification without awaiting (fire-and-forget)
      void adapter.notify({
        status: 'passed',
        repoId: TEST_REPO_ID,
        issueNumber: 42,
        displayId: 'run-1',
      });

      let exitCalled = false;
      const mockExit = () => {
        exitCalled = true;
      };

      // drain is started before exit
      let drained = false;
      const drainPromise = adapter.drain(1000).then(() => {
        drained = true;
        mockExit();
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(drained).toBe(false);
      expect(exitCalled).toBe(false);

      // fetch finishes
      resolveFetch(new Response('OK', { status: 200 }));
      await drainPromise;

      expect(drained).toBe(true);
      expect(exitCalled).toBe(true);
    });

    it('awaits drainStartupSweeps before runNotification.drain and process.exit in drainAndExit', async () => {
      const order: string[] = [];
      const fakeContainer = {
        drainStartupSweeps: vi.fn().mockImplementation(async () => {
          order.push('drainStartupSweeps');
        }),
        runNotification: {
          notify: vi.fn(),
          drain: vi.fn().mockImplementation(async () => {
            order.push('runNotification.drain');
          }),
        },
      } as unknown as Container;

      exitMock.mockImplementation(() => {
        order.push('process.exit');
      });

      await drainAndExit(fakeContainer, 42);

      expect(order).toEqual(['drainStartupSweeps', 'runNotification.drain', 'process.exit']);
      expect(exitMock).toHaveBeenCalledWith(42);
    });

    it('handles offline-merged PR notification dispatched during startup sweep in drainAndExit', async () => {
      let resolveFetch!: (val: Response) => void;
      const fetchPromise = new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
      const fetchImpl = vi.fn().mockReturnValue(fetchPromise);
      const adapter = new WebhookRunNotificationAdapter(
        'https://example.com',
        undefined,
        fetchImpl,
      );

      const fakeContainer = {
        drainStartupSweeps: vi.fn().mockImplementation(async () => {
          // Simulates SweepWaitingRuns finding a merged PR and dispatching notification
          void adapter.notify({
            status: 'passed',
            repoId: TEST_REPO_ID,
            issueNumber: 101,
            displayId: 'run-101',
          });
        }),
        runNotification: adapter,
      } as unknown as Container;

      let exitCalled = false;
      exitMock.mockImplementation(() => {
        exitCalled = true;
      });

      const exitPromise = drainAndExit(fakeContainer, 1);

      // Verify that while fetch is unresolved, process.exit has not been called
      await new Promise((r) => setTimeout(r, 10));
      expect(exitCalled).toBe(false);

      // Resolve the webhook POST
      resolveFetch(new Response('OK', { status: 200 }));
      await exitPromise;

      expect(exitCalled).toBe(true);
      expect(exitMock).toHaveBeenCalledWith(1);
    });

    it('exits cleanly when container is undefined in drainAndExit', async () => {
      await drainAndExit(undefined, 0);
      expect(exitMock).toHaveBeenCalledWith(0);
    });

    it('still calls process.exit even if drain throws in drainAndExit', async () => {
      const failingContainer = {
        drainStartupSweeps: vi.fn().mockRejectedValue(new Error('sweep failed')),
        runNotification: {
          notify: vi.fn(),
          drain: vi.fn().mockRejectedValue(new Error('drain failed')),
        },
      } as unknown as Container;

      await drainAndExit(failingContainer, 1);
      expect(exitMock).toHaveBeenCalledWith(1);
    });

    it('awaits onCleanup and delegates to onExit in installSignalHandlers on SIGINT', async () => {
      const runRepository = makeRunRepositorySpies();
      const order: string[] = [];
      const cleanupMock = vi.fn().mockImplementation(async () => {
        order.push('cleanup');
      });
      const onExitMock = vi.fn().mockImplementation(async (code: number) => {
        order.push(`onExit:${code}`);
      });

      const handlers = installSignalHandlers(
        runRepository,
        TEST_REPO_ID,
        42,
        cleanupMock,
        onExitMock,
      );

      process.emit('SIGINT', 'SIGINT');

      // Wait a tick for async cleanup promise chain
      await new Promise((r) => setTimeout(r, 10));

      expect(order).toEqual(['cleanup', 'onExit:130']);
      expect(exitMock).not.toHaveBeenCalled();

      handlers.remove();
    });
  });
});
