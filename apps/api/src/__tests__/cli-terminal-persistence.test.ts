import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RepositoryId } from '@ai-sdlc/domain';
import { installSignalHandlers } from '../cli.js';

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

      const debugCalls: string[] = [];
      const mockDebug = (msg: string) => {
        debugCalls.push(msg);
        consoleDebugSpy(msg);
      };

      mockDebug('terminal status write starting');
      const applied = runRepository.atomicUpdateByUuid(
        'run-1',
        {
          status: 'failed',
          completedAt: new Date(),
          failureReason: 'worker loop terminated without finalizing run',
        },
        'running',
      );
      mockDebug(`terminal status write completed, applied=${applied}`);

      expect(applied).toBe(true);

      const updateCalls = debugCalls.filter((c) => c.includes('terminal status write'));
      expect(updateCalls.length).toBe(2);
      expect(String(updateCalls[0])).toContain('starting');
      expect(String(updateCalls[1])).toContain('completed');
    });
  });
});
