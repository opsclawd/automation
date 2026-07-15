import { describe, it, expect, vi } from 'vitest';
import type { FairRepositoryScheduler } from '@ai-sdlc/application';

vi.mock('@ai-sdlc/application');

const mockScheduler = (): Partial<FairRepositoryScheduler> => ({
  stopAdmission: vi.fn(),
  drain: vi.fn().mockResolvedValue({ drained: true, remainingWorkerIds: [] }),
});

describe('ShutdownCoordinator', () => {
  const DEFAULT_SHUTDOWN_GRACE_MS = 30_000;

  describe('shutdown coordinator is idempotent', () => {
    it('concurrent signals share one cleanup promise', async () => {
      const { ShutdownCoordinator } = await import('../shutdown-coordinator.js');
      const scheduler = mockScheduler();
      const runtimeCatalog = { close: vi.fn().mockResolvedValue(undefined) };
      const server = { stop: vi.fn().mockResolvedValue(undefined) };
      const auxiliaryTimers = [{ stop: vi.fn() }];

      const coordinator = new ShutdownCoordinator({
        scheduler: scheduler as FairRepositoryScheduler,
        runtimeCatalog: runtimeCatalog as { close: () => Promise<void> },
        server: () => server,
        auxiliaryTimers,
        shutdownGraceMs: DEFAULT_SHUTDOWN_GRACE_MS,
      });

      const abortController = new AbortController();

      const promise1 = coordinator.shutdown(abortController.signal);
      const promise2 = coordinator.shutdown(abortController.signal);

      await promise1;
      await promise2;

      expect(scheduler.stopAdmission).toHaveBeenCalledTimes(1);
      expect(scheduler.drain).toHaveBeenCalledTimes(1);
    });

    it('repeated signals do not close resources twice', async () => {
      const { ShutdownCoordinator } = await import('../shutdown-coordinator.js');
      const scheduler = mockScheduler();
      const runtimeCatalog = { close: vi.fn().mockResolvedValue(undefined) };
      const server = { stop: vi.fn().mockResolvedValue(undefined) };
      const auxiliaryTimers = [{ stop: vi.fn() }];

      const coordinator = new ShutdownCoordinator({
        scheduler: scheduler as FairRepositoryScheduler,
        runtimeCatalog: runtimeCatalog as { close: () => Promise<void> },
        server: () => server,
        auxiliaryTimers,
        shutdownGraceMs: DEFAULT_SHUTDOWN_GRACE_MS,
      });

      const abortController = new AbortController();

      await coordinator.shutdown(abortController.signal);
      await coordinator.shutdown(abortController.signal);

      expect(runtimeCatalog.close).toHaveBeenCalledTimes(1);
      expect(server.stop).toHaveBeenCalledTimes(1);
    });
  });

  describe('shutdown drains before runtime close', () => {
    it('stopAdmission is called before drain', async () => {
      const { ShutdownCoordinator } = await import('../shutdown-coordinator.js');
      const scheduler = mockScheduler();
      const runtimeCatalog = { close: vi.fn().mockResolvedValue(undefined) };
      const server = { stop: vi.fn().mockResolvedValue(undefined) };
      const auxiliaryTimers = [{ stop: vi.fn() }];

      const coordinator = new ShutdownCoordinator({
        scheduler: scheduler as FairRepositoryScheduler,
        runtimeCatalog: runtimeCatalog as { close: () => Promise<void> },
        server: () => server,
        auxiliaryTimers,
        shutdownGraceMs: DEFAULT_SHUTDOWN_GRACE_MS,
      });

      const abortController = new AbortController();
      await coordinator.shutdown(abortController.signal);

      const stopAdmissionCallIndex = vi.mocked(scheduler.stopAdmission).mock.invocationCallOrder[0];
      const drainCallIndex = vi.mocked(scheduler.drain).mock.invocationCallOrder[0];
      const closeCallIndex = vi.mocked(runtimeCatalog.close).mock.invocationCallOrder[0];

      expect(stopAdmissionCallIndex).toBeLessThan(drainCallIndex);
      expect(drainCallIndex).toBeLessThan(closeCallIndex);
    });
  });

  describe('shutdown does not call process exit before cleanup', () => {
    it('returns exit code without calling process.exit', async () => {
      const { ShutdownCoordinator } = await import('../shutdown-coordinator.js');
      const scheduler = mockScheduler();
      const runtimeCatalog = { close: vi.fn().mockResolvedValue(undefined) };
      const server = { stop: vi.fn().mockResolvedValue(undefined) };
      const auxiliaryTimers = [{ stop: vi.fn() }];

      const coordinator = new ShutdownCoordinator({
        scheduler: scheduler as FairRepositoryScheduler,
        runtimeCatalog: runtimeCatalog as { close: () => Promise<void> },
        server: () => server,
        auxiliaryTimers,
        shutdownGraceMs: DEFAULT_SHUTDOWN_GRACE_MS,
      });

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      const abortController = new AbortController();

      await coordinator.shutdown(abortController.signal);

      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  describe('incomplete drain still closes resources and returns failure', () => {
    it('returns failure when drain times out but still closes resources', async () => {
      const { ShutdownCoordinator } = await import('../shutdown-coordinator.js');
      const scheduler = {
        ...mockScheduler(),
        drain: vi.fn().mockResolvedValue({
          drained: false,
          remainingWorkerIds: ['worker-1', 'worker-2'],
        }),
      };
      const runtimeCatalog = { close: vi.fn().mockResolvedValue(undefined) };
      const server = { stop: vi.fn().mockResolvedValue(undefined) };
      const auxiliaryTimers = [{ stop: vi.fn() }];

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const coordinator = new ShutdownCoordinator({
        scheduler: scheduler as FairRepositoryScheduler,
        runtimeCatalog: runtimeCatalog as { close: () => Promise<void> },
        server: () => server,
        auxiliaryTimers,
        shutdownGraceMs: DEFAULT_SHUTDOWN_GRACE_MS,
      });

      const abortController = new AbortController();
      const result = await coordinator.shutdown(abortController.signal);

      expect(result.ok).toBe(false);
      expect(result.remainingWorkerIds).toEqual(['worker-1', 'worker-2']);
      expect(runtimeCatalog.close).toHaveBeenCalled();
      expect(server.stop).toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('drain timed out, 2 workers still active: worker-1, worker-2'),
      );
    });
  });
});
