import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RepositoryId, WorkerId, createJob, createWorker } from '@ai-sdlc/domain';
import type { JobId, RunId } from '@ai-sdlc/domain';
import {
  FakeJobQueuePort,
  FakeWorkerLeasePort,
  FakeWorkerRegistryPort,
  FakeRepositoryPort,
  FakeRunRepository,
} from '@ai-sdlc/application/test-doubles';
import { startWorkerDrainLoop } from '../worker-drain-loop.js';

describe('startWorkerDrainLoop', () => {
  const workerId = WorkerId('serve-1');

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('claims and executes a queued job on the first tick', async () => {
    const repos = new FakeRepositoryPort([
      {
        id: RepositoryId('owner/repo'),
        fullName: 'owner/repo',
        localBasePath: '/tmp/owner-repo',
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
        id: workerId,
        repoId: RepositoryId('owner/repo'),
        hostname: 'test',
        processId: 1,
        now: new Date(),
      }),
    );
    queue.enqueue({
      job: createJob({
        id: 'job-1' as JobId,
        runId: 'run-1' as RunId,
        repoId: RepositoryId('owner/repo'),
        issueNumber: 7 as never,
        priority: 0,
        createdAt: new Date(),
      }),
    });

    const executeRun = vi.fn().mockResolvedValue({ ok: true });
    const { stop } = startWorkerDrainLoop(
      workerId,
      {
        registry,
        queue,
        leases,
        repos,
        repoId: RepositoryId('owner/repo'),
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
            repoId: RepositoryId('owner/repo'),
            issueNumber: 7,
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
      await vi.advanceTimersByTimeAsync(1_000);
      expect(executeRun).toHaveBeenCalledTimes(1);
      expect(queue.findById('job-1' as JobId)?.status).toBe('succeeded');
    } finally {
      stop();
    }
  });

  it('reclaims a stale claim before each tick using deps.now() as cutoff', async () => {
    const repos = new FakeRepositoryPort([
      {
        id: RepositoryId('owner/repo'),
        fullName: 'owner/repo',
        localBasePath: '/tmp/owner-repo',
        defaultBranch: 'main',
        enabled: true,
      } as never,
    ]);
    const queue = new FakeJobQueuePort(repos);
    const runRepo = new FakeRunRepository();
    const reclaimSpy = vi.spyOn(queue, 'reclaimStaleClaims');
    const registry = new FakeWorkerRegistryPort();
    const leases = new FakeWorkerLeasePort(registry);
    registry.register(
      createWorker({
        id: workerId,
        repoId: RepositoryId('owner/repo'),
        hostname: 'test',
        processId: 1,
        now: new Date(),
      }),
    );

    const { stop } = startWorkerDrainLoop(
      workerId,
      {
        registry,
        queue,
        leases,
        repos,
        repoId: RepositoryId('owner/repo'),
        runRepository: runRepo,
        executeRun: async () => ({ ok: true }),
        prepareWorktree: async () => ({ cwd: '/tmp/wt' }),
        resetWorktree: () => {},
        isWorkerAlive: () => true,
        now: () => new Date(),
        ttlMs: 60_000,
        findRun: () => undefined,
      },
      1_000,
    );

    try {
      await vi.advanceTimersByTimeAsync(2_000);
      expect(reclaimSpy).toHaveBeenCalledTimes(2);
      expect(reclaimSpy).toHaveBeenLastCalledWith(expect.any(Date));
      const passedCutoff = reclaimSpy.mock.calls[1]?.[0];
      expect(passedCutoff?.getTime()).toBeCloseTo(Date.now(), -2);
    } finally {
      stop();
    }
  });

  it('stop() prevents further ticks', async () => {
    const repos = new FakeRepositoryPort();
    const queue = new FakeJobQueuePort(repos);
    const runRepo = new FakeRunRepository();
    const reclaimSpy = vi.spyOn(queue, 'reclaimStaleClaims');
    const registry = new FakeWorkerRegistryPort();
    const leases = new FakeWorkerLeasePort(registry);
    registry.register(
      createWorker({
        id: workerId,
        repoId: RepositoryId('owner/repo'),
        hostname: 'test',
        processId: 1,
        now: new Date(),
      }),
    );

    const { stop } = startWorkerDrainLoop(
      workerId,
      {
        registry,
        queue,
        leases,
        repos,
        repoId: RepositoryId('owner/repo'),
        runRepository: runRepo,
        executeRun: async () => ({ ok: true }),
        prepareWorktree: async () => ({ cwd: '/tmp/wt' }),
        resetWorktree: () => {},
        isWorkerAlive: () => true,
        now: () => new Date(),
        ttlMs: 60_000,
        findRun: () => undefined,
      },
      1_000,
    );
    stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reclaimSpy).not.toHaveBeenCalled();
  });
});
