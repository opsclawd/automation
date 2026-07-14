import { describe, expect, it, vi } from 'vitest';
import type { LoggerPort } from '@ai-sdlc/application/ports/logger-port.js';

const mockLogger: LoggerPort = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('RepositorySchedulerAdapter', () => {
  describe('inspect', () => {
    it('resolves the runtime, counts queued jobs for queueDepth, and active jobs for activeCount', async () => {
      const { RepositorySchedulerAdapter } = await import('../repository-scheduler-adapter.js');

      const repo = {
        id: 'owner/repo' as import('@ai-sdlc/domain').RepositoryId,
        name: 'repo',
        fullName: 'owner/repo',
        enabled: true,
        healthStatus: 'healthy' as const,
        maxConcurrentRuns: 2,
      };

      const runtime = {
        repository: repo,
        jobQueue: {
          listForRepo: vi.fn(() => [
            { id: 'j1', status: 'queued' },
            { id: 'j2', status: 'queued' },
            { id: 'j3', status: 'running' },
          ]),
        },
        workerLeaseRepository: {
          checkActiveLease: vi.fn(() => true),
        },
        close: vi.fn(),
      };

      const factory = vi.fn(() => Promise.resolve(runtime));

      const adapter = new RepositorySchedulerAdapter({
        repoId: repo.id,
        runtimeFactory: factory,
        logger: mockLogger,
      });

      const result = await adapter.inspect(repo);

      expect(result).toEqual({
        available: true,
        queueDepth: 2,
        activeCount: 1,
      });
      expect(factory).toHaveBeenCalledWith(repo);
    });

    it('returns unavailable when runtime throws during construction', async () => {
      const { RepositorySchedulerAdapter } = await import('../repository-scheduler-adapter.js');

      const repo = {
        id: 'owner/repo' as import('@ai-sdlc/domain').RepositoryId,
        name: 'repo',
        fullName: 'owner/repo',
        enabled: true,
        healthStatus: 'healthy' as const,
        maxConcurrentRuns: 2,
      };

      const factory = vi.fn(() => Promise.reject(new Error('runtime unavailable')));

      const adapter = new RepositorySchedulerAdapter({
        repoId: repo.id,
        runtimeFactory: factory,
        logger: mockLogger,
      });

      const result = await adapter.inspect(repo);

      expect(result).toEqual({
        available: false,
        reason: 'unavailable',
        detail: 'runtime unavailable',
      });
    });

    it('returns unavailable when repository is disabled', async () => {
      const { RepositorySchedulerAdapter } = await import('../repository-scheduler-adapter.js');

      const repo = {
        id: 'owner/repo' as import('@ai-sdlc/domain').RepositoryId,
        name: 'repo',
        fullName: 'owner/repo',
        enabled: false,
        healthStatus: 'healthy' as const,
        maxConcurrentRuns: 2,
      };

      const adapter = new RepositorySchedulerAdapter({
        repoId: repo.id,
        runtimeFactory: vi.fn(),
        logger: mockLogger,
      });

      const result = await adapter.inspect(repo);

      expect(result).toEqual({
        available: false,
        reason: 'disabled',
        detail: 'Repository owner/repo is disabled',
      });
    });

    it('returns unhealthy when repository has degraded health', async () => {
      const { RepositorySchedulerAdapter } = await import('../repository-scheduler-adapter.js');

      const repo = {
        id: 'owner/repo' as import('@ai-sdlc/domain').RepositoryId,
        name: 'repo',
        fullName: 'owner/repo',
        enabled: true,
        healthStatus: 'degraded' as const,
        healthError: 'disk space low',
        maxConcurrentRuns: 2,
      };

      const adapter = new RepositorySchedulerAdapter({
        repoId: repo.id,
        runtimeFactory: vi.fn(),
        logger: mockLogger,
      });

      const result = await adapter.inspect(repo);

      expect(result).toEqual({
        available: false,
        reason: 'unhealthy',
        detail: 'disk space low',
      });
    });
  });

  describe('runOne', () => {
    it('registers a unique repository-bound worker, starts heartbeat, calls workerLoop once, and cleans up in finally', async () => {
      const { RepositorySchedulerAdapter } = await import('../repository-scheduler-adapter.js');

      const repo = {
        id: 'owner/repo' as import('@ai-sdlc/domain').RepositoryId,
        name: 'repo',
        fullName: 'owner/repo',
        enabled: true,
        healthStatus: 'healthy' as const,
        maxConcurrentRuns: 2,
      };

      const registeredWorkerIds: import('@ai-sdlc/domain').WorkerId[] = [];
      const heartbeatCalls: Array<{
        workerId: import('@ai-sdlc/domain').WorkerId;
        runId: import('@ai-sdlc/domain').RunId;
      }> = [];
      const deregisteredWorkerIds: import('@ai-sdlc/domain').WorkerId[] = [];

      const runtime = {
        repository: repo,
        workerRegistry: {
          register: vi.fn(
            async (input: {
              workerId: import('@ai-sdlc/domain').WorkerId;
              repoId: import('@ai-sdlc/domain').RepositoryId;
            }) => {
              registeredWorkerIds.push(input.workerId);
              return { status: 'ok' as const };
            },
          ),
          heartbeat: vi.fn(
            async (input: {
              workerId: import('@ai-sdlc/domain').WorkerId;
              runId: import('@ai-sdlc/domain').RunId;
            }) => {
              heartbeatCalls.push(input);
            },
          ),
          markIdle: vi.fn(async (input: { workerId: import('@ai-sdlc/domain').WorkerId }) => {
            deregisteredWorkerIds.push(input.workerId);
          }),
        },
        workerLeaseRepository: {
          checkActiveLease: vi.fn(() => true),
        },
        jobQueue: {
          listForRepo: vi.fn(() => []),
        },
        close: vi.fn(),
      };

      const factory = vi.fn(() => Promise.resolve(runtime));

      const workerLoop = vi.fn().mockResolvedValue(undefined);

      const adapter = new RepositorySchedulerAdapter({
        repoId: repo.id,
        runtimeFactory: factory,
        logger: mockLogger,
        workerLoop,
      });

      const workerId = 'w-test-1' as import('@ai-sdlc/domain').WorkerId;
      const result = await adapter.runOne({ repository: repo, workerId });

      expect(result).toBe('completed');
      expect(workerLoop).toHaveBeenCalledTimes(1);

      const registeredWorkerId = registeredWorkerIds[0];
      expect(registeredWorkerId).toBe(workerId);
      expect(runtime.workerRegistry.register).toHaveBeenCalledWith({
        workerId,
        repoId: repo.id,
      });
    });

    it('returns no_work when there are no queued jobs', async () => {
      const { RepositorySchedulerAdapter } = await import('../repository-scheduler-adapter.js');

      const repo = {
        id: 'owner/repo' as import('@ai-sdlc/domain').RepositoryId,
        name: 'repo',
        fullName: 'owner/repo',
        enabled: true,
        healthStatus: 'healthy' as const,
        maxConcurrentRuns: 2,
      };

      const runtime = {
        repository: repo,
        workerRegistry: {
          register: vi.fn(),
          heartbeat: vi.fn(),
          markIdle: vi.fn(),
        },
        workerLeaseRepository: {
          checkActiveLease: vi.fn(() => false),
        },
        jobQueue: {
          listForRepo: vi.fn(() => []),
        },
        close: vi.fn(),
      };

      const factory = vi.fn(() => Promise.resolve(runtime));
      const workerLoop = vi.fn().mockResolvedValue(undefined);

      const adapter = new RepositorySchedulerAdapter({
        repoId: repo.id,
        runtimeFactory: factory,
        logger: mockLogger,
        workerLoop,
      });

      const workerId = 'w-test-1' as import('@ai-sdlc/domain').WorkerId;
      const result = await adapter.runOne({ repository: repo, workerId });

      expect(result).toBe('no_work');
      expect(workerLoop).not.toHaveBeenCalled();
    });

    it('releases registration in finally block on success', async () => {
      const { RepositorySchedulerAdapter } = await import('../repository-scheduler-adapter.js');

      const repo = {
        id: 'owner/repo' as import('@ai-sdlc/domain').RepositoryId,
        name: 'repo',
        fullName: 'owner/repo',
        enabled: true,
        healthStatus: 'healthy' as const,
        maxConcurrentRuns: 2,
      };

      const deregisteredWorkerIds: import('@ai-sdlc/domain').WorkerId[] = [];

      const runtime = {
        repository: repo,
        workerRegistry: {
          register: vi.fn(),
          heartbeat: vi.fn(),
          markIdle: vi.fn(async (input: { workerId: import('@ai-sdlc/domain').WorkerId }) => {
            deregisteredWorkerIds.push(input.workerId);
          }),
        },
        workerLeaseRepository: {
          checkActiveLease: vi.fn(() => true),
        },
        jobQueue: {
          listForRepo: vi.fn(() => [{ id: 'j1', status: 'queued' }]),
        },
        close: vi.fn(),
      };

      const factory = vi.fn(() => Promise.resolve(runtime));
      const workerLoop = vi.fn().mockResolvedValue(undefined);

      const adapter = new RepositorySchedulerAdapter({
        repoId: repo.id,
        runtimeFactory: factory,
        logger: mockLogger,
        workerLoop,
      });

      const workerId = 'w-test-1' as import('@ai-sdlc/domain').WorkerId;
      await adapter.runOne({ repository: repo, workerId });

      expect(deregisteredWorkerIds).toContain(workerId);
    });

    it('releases registration in finally block on failure', async () => {
      const { RepositorySchedulerAdapter } = await import('../repository-scheduler-adapter.js');

      const repo = {
        id: 'owner/repo' as import('@ai-sdlc/domain').RepositoryId,
        name: 'repo',
        fullName: 'owner/repo',
        enabled: true,
        healthStatus: 'healthy' as const,
        maxConcurrentRuns: 2,
      };

      const deregisteredWorkerIds: import('@ai-sdlc/domain').WorkerId[] = [];

      const runtime = {
        repository: repo,
        workerRegistry: {
          register: vi.fn(),
          heartbeat: vi.fn(),
          markIdle: vi.fn(async (input: { workerId: import('@ai-sdlc/domain').WorkerId }) => {
            deregisteredWorkerIds.push(input.workerId);
          }),
        },
        workerLeaseRepository: {
          checkActiveLease: vi.fn(() => true),
        },
        jobQueue: {
          listForRepo: vi.fn(() => [{ id: 'j1', status: 'queued' }]),
        },
        close: vi.fn(),
      };

      const factory = vi.fn(() => Promise.resolve(runtime));
      const workerLoop = vi.fn().mockRejectedValue(new Error('worker loop failed'));

      const adapter = new RepositorySchedulerAdapter({
        repoId: repo.id,
        runtimeFactory: factory,
        logger: mockLogger,
        workerLoop,
      });

      const workerId = 'w-test-1' as import('@ai-sdlc/domain').WorkerId;
      await expect(adapter.runOne({ repository: repo, workerId })).rejects.toThrow(
        'worker loop failed',
      );

      expect(deregisteredWorkerIds).toContain(workerId);
    });

    it('releases registration in finally block on no_work', async () => {
      const { RepositorySchedulerAdapter } = await import('../repository-scheduler-adapter.js');

      const repo = {
        id: 'owner/repo' as import('@ai-sdlc/domain').RepositoryId,
        name: 'repo',
        fullName: 'owner/repo',
        enabled: true,
        healthStatus: 'healthy' as const,
        maxConcurrentRuns: 2,
      };

      const deregisteredWorkerIds: import('@ai-sdlc/domain').WorkerId[] = [];

      const runtime = {
        repository: repo,
        workerRegistry: {
          register: vi.fn(),
          heartbeat: vi.fn(),
          markIdle: vi.fn(async (input: { workerId: import('@ai-sdlc/domain').WorkerId }) => {
            deregisteredWorkerIds.push(input.workerId);
          }),
        },
        workerLeaseRepository: {
          checkActiveLease: vi.fn(() => false),
        },
        jobQueue: {
          listForRepo: vi.fn(() => []),
        },
        close: vi.fn(),
      };

      const factory = vi.fn(() => Promise.resolve(runtime));
      const workerLoop = vi.fn();

      const adapter = new RepositorySchedulerAdapter({
        repoId: repo.id,
        runtimeFactory: factory,
        logger: mockLogger,
        workerLoop,
      });

      const workerId = 'w-test-1' as import('@ai-sdlc/domain').WorkerId;
      await adapter.runOne({ repository: repo, workerId });

      expect(deregisteredWorkerIds).toContain(workerId);
    });
  });
});
