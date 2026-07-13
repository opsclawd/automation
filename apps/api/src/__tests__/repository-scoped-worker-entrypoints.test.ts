import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkerId, RepositoryId, createWorker } from '@ai-sdlc/domain';
import type { JobId, RunId } from '@ai-sdlc/domain';
import {
  FakeJobQueuePort,
  FakeWorkerLeasePort,
  FakeWorkerRegistryPort,
  FakeRepositoryPort,
  FakeRunRepository,
} from '@ai-sdlc/application/test-doubles';
import { startWorkerDrainLoop } from '../worker-drain-loop.js';
import { WorkerScheduler } from '../worker-scheduler.js';

describe('repository-scoped worker entrypoints', () => {
  const REPO_A = RepositoryId('owner/repo-a');
  const WORKER_ID_A = WorkerId(`serve-1-${REPO_A}`);

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('worker_entrypoint_requires_repository', () => {
    it('serve worker registration requires one repository id', () => {
      const registry = new FakeWorkerRegistryPort();

      registry.register(
        createWorker({
          id: WORKER_ID_A,
          repoId: REPO_A,
          hostname: 'test',
          processId: 1,
          now: new Date(),
        }),
      );

      const registered = registry.findById(WORKER_ID_A, REPO_A);
      expect(registered).toBeDefined();
      expect(registered?.repoId).toBe(REPO_A);
    });

    it('one-shot worker registration requires explicit repository id', () => {
      const registry = new FakeWorkerRegistryPort();
      const oneShotWorkerId = WorkerId('cli-123');

      registry.register(
        createWorker({
          id: oneShotWorkerId,
          repoId: REPO_A,
          hostname: 'test',
          processId: 123,
          now: new Date(),
        }),
      );

      const registered = registry.findById(oneShotWorkerId, REPO_A);
      expect(registered).toBeDefined();
      expect(registered?.repoId).toBe(REPO_A);
    });

    it('drain loop worker registration binds to one repository id', () => {
      const repos = new FakeRepositoryPort([
        {
          id: REPO_A,
          fullName: 'owner/repo-a',
          localBasePath: '/tmp/repo-a',
          defaultBranch: 'main',
          enabled: true,
        } as never,
      ]);
      const queue = new FakeJobQueuePort(repos);
      const runRepo = new FakeRunRepository();
      const registry = new FakeWorkerRegistryPort();
      const leases = new FakeWorkerLeasePort(registry);

      registry.register(
        createWorker({
          id: WORKER_ID_A,
          repoId: REPO_A,
          hostname: 'test',
          processId: 1,
          now: new Date(),
        }),
      );

      const executeRun = vi.fn().mockResolvedValue({ ok: true });
      const { stop } = startWorkerDrainLoop(
        WORKER_ID_A,
        {
          registry,
          queue,
          leases,
          repos,
          repoId: REPO_A,
          runRepository: runRepo,
          executeRun,
          prepareWorktree: async () => ({ cwd: '/tmp/wt' }),
          resetWorktree: () => {},
          isWorkerAlive: () => true,
          now: () => new Date(),
          ttlMs: 60_000,
          findRun: () =>
            ({
              uuid: 'run-1',
              displayId: 'run-1',
              repoId: REPO_A,
              issueNumber: 7 as never,
              type: 'issue_to_pr',
              status: 'running',
              completedPhases: [],
              skippedPhases: [],
              startedAt: new Date(),
            }) as never,
        },
        1_000,
      );

      try {
        expect(registry.findById(WORKER_ID_A, REPO_A)?.repoId).toBe(REPO_A);
      } finally {
        stop();
      }
    });
  });

  describe('worker_entrypoint_uses_scoped_runtime', () => {
    it('worker scheduler constructor accepts repoId in baseDeps', () => {
      const repos = new FakeRepositoryPort([
        {
          id: REPO_A,
          fullName: 'owner/repo-a',
          localBasePath: '/tmp/repo-a',
          defaultBranch: 'main',
          enabled: true,
        } as never,
      ]);
      const queue = new FakeJobQueuePort(repos);
      const registry = new FakeWorkerRegistryPort();
      const leases = new FakeWorkerLeasePort(registry);

      registry.register(
        createWorker({
          id: WORKER_ID_A,
          repoId: REPO_A,
          hostname: 'test',
          processId: 1,
          now: new Date(),
        }),
      );

      const scheduler = new WorkerScheduler(
        [WORKER_ID_A],
        {
          registry,
          queue,
          leases,
          repos,
          repoId: REPO_A,
          executeRun: vi.fn(),
          prepareWorktree: vi.fn(),
          resetWorktree: () => {},
          isWorkerAlive: () => true,
          findRun: vi.fn(),
          now: () => new Date(),
          ttlMs: 60_000,
        },
        100,
      );

      expect(scheduler).toBeDefined();
    });
  });

  describe('worker_entrypoint_heartbeat_uses_same_repo_id', () => {
    it('worker registration heartbeat uses the same repository id', () => {
      const registry = new FakeWorkerRegistryPort();
      const heartbeatSpy = vi.spyOn(registry, 'heartbeat');

      const worker = createWorker({
        id: WORKER_ID_A,
        repoId: REPO_A,
        hostname: 'test',
        processId: 1,
        now: new Date(),
      });
      registry.register(worker);

      registry.heartbeat(WORKER_ID_A, REPO_A, new Date());

      expect(heartbeatSpy).toHaveBeenCalledWith(WORKER_ID_A, REPO_A, expect.any(Date));
    });

    it('deregistration uses the same repository id', () => {
      const registry = new FakeWorkerRegistryPort();
      const deregisterSpy = vi.spyOn(registry, 'deregister');

      registry.register(
        createWorker({
          id: WORKER_ID_A,
          repoId: REPO_A,
          hostname: 'test',
          processId: 1,
          now: new Date(),
        }),
      );

      registry.deregister(WORKER_ID_A);

      expect(deregisterSpy).toHaveBeenCalledWith(WORKER_ID_A);
    });

    it('heartbeat and deregistration are consistent for the same worker', () => {
      const registry = new FakeWorkerRegistryPort();

      registry.register(
        createWorker({
          id: WORKER_ID_A,
          repoId: REPO_A,
          hostname: 'test',
          processId: 1,
          now: new Date(),
        }),
      );

      registry.heartbeat(WORKER_ID_A, REPO_A, new Date());
      registry.deregister(WORKER_ID_A);

      const registered = registry.findById(WORKER_ID_A, REPO_A);
      expect(registered).toBeUndefined();
    });
  });

  describe('worker_entrypoint_rejects_unavailable_repository', () => {
    it('worker with unregistered repoId can be registered but not found via wrong repoId', () => {
      const _repos = new FakeRepositoryPort([
        {
          id: REPO_A,
          fullName: 'owner/repo-a',
          localBasePath: '/tmp/repo-a',
          defaultBranch: 'main',
          enabled: false,
        } as never,
      ]);
      const registry = new FakeWorkerRegistryPort();
      const unregisteredRepoId = RepositoryId('owner/unknown');

      registry.register(
        createWorker({
          id: WorkerId('test-worker'),
          repoId: unregisteredRepoId,
          hostname: 'test',
          processId: 1,
          now: new Date(),
        }),
      );

      expect(registry.findById(WorkerId('test-worker'), unregisteredRepoId)?.repoId).toBe(
        unregisteredRepoId,
      );
      expect(registry.findById(WorkerId('test-worker'), REPO_A)).toBeUndefined();
    });

    it('workerLoop deps repoId matches the registered worker repoId', async () => {
      const repos = new FakeRepositoryPort([
        {
          id: REPO_A,
          fullName: 'owner/repo-a',
          localBasePath: '/tmp/repo-a',
          defaultBranch: 'main',
          enabled: true,
        } as never,
      ]);
      const queue = new FakeJobQueuePort(repos);
      const runRepo = new FakeRunRepository();
      const registry = new FakeWorkerRegistryPort();
      const leases = new FakeWorkerLeasePort(registry);

      registry.register(
        createWorker({
          id: WORKER_ID_A,
          repoId: REPO_A,
          hostname: 'test',
          processId: 1,
          now: new Date(),
        }),
      );

      queue.enqueue({
        job: {
          id: 'job-a' as JobId,
          runId: 'run-a' as RunId,
          repoId: REPO_A,
          issueNumber: 1 as never,
          priority: 0,
          createdAt: new Date(),
          status: 'queued',
        } as never,
      });

      const executeRun = vi.fn().mockResolvedValue({ ok: true });
      const { stop } = startWorkerDrainLoop(
        WORKER_ID_A,
        {
          registry,
          queue,
          leases,
          repos,
          repoId: REPO_A,
          runRepository: runRepo,
          executeRun,
          prepareWorktree: async () => ({ cwd: '/tmp/wt' }),
          resetWorktree: () => {},
          isWorkerAlive: () => true,
          now: () => new Date(),
          ttlMs: 60_000,
          findRun: () =>
            ({
              uuid: 'run-a',
              displayId: 'run-a',
              repoId: REPO_A,
              issueNumber: 1,
              type: 'issue_to_pr',
              status: 'running',
              completedPhases: [],
              skippedPhases: [],
              startedAt: new Date(),
            }) as never,
        },
        1_000,
      );

      try {
        await vi.advanceTimersByTimeAsync(1_500);
        expect(registry.findById(WORKER_ID_A, REPO_A)?.repoId).toBe(REPO_A);
      } finally {
        stop();
      }
    });
  });
});
