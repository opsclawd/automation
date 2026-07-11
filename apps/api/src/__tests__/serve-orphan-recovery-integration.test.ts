import { describe, it, expect, beforeEach } from 'vitest';
import { createRun, RepositoryId, WorkerId, createWorker } from '@ai-sdlc/domain';
import { SweepOrphanedRuns, OrphanedRunsSweeper, workerLoop } from '@ai-sdlc/application';
import {
  FakeRunRepository,
  FakeEventBus,
  FakeJobQueuePort,
  FakeWorkerLeasePort,
  FakeWorkerRegistryPort,
  FakeRepositoryPort,
} from '@ai-sdlc/application/test-doubles';

const fixedNow = new Date('2026-07-10T01:00:00Z');
const serveWorkerId = WorkerId('serve-1');
const repoId = RepositoryId('owner/repo');

describe('serve orphan-recovery integration', () => {
  let runRepo: FakeRunRepository;
  let queue: FakeJobQueuePort;
  let leases: FakeWorkerLeasePort;
  let registry: FakeWorkerRegistryPort;
  let repos: FakeRepositoryPort;
  let eventBus: FakeEventBus;

  beforeEach(() => {
    runRepo = new FakeRunRepository();
    registry = new FakeWorkerRegistryPort();
    repos = new FakeRepositoryPort([
      {
        id: repoId,
        fullName: 'owner/repo',
        localBasePath: '/tmp/owner-repo',
        defaultBranch: 'main',
        enabled: true,
      } as never,
    ]);
    queue = new FakeJobQueuePort(repos);
    leases = new FakeWorkerLeasePort(registry);
    eventBus = new FakeEventBus();
    registry.register(
      createWorker({ id: serveWorkerId, hostname: 'test', processId: 1, now: fixedNow }),
    );
  });

  it('AC1: dead-pid running run is detected, marked failed, then enqueued and driven to completion', async () => {
    const crashed = createRun({
      uuid: 'orphan-r1',
      displayId: 'issue-7-20260710-000000',
      repoId,
      issueNumber: 7,
      startedAt: new Date('2026-07-09T00:00:00Z'),
    });
    runRepo.addRun({ ...crashed, pid: 424242 });

    const sweep = new SweepOrphanedRuns({
      runRepository: runRepo,
      isProcessAlive: (pid) => pid !== 424242,
      now: () => fixedNow,
    });
    const sweepResult = sweep.execute();
    expect(sweepResult.swept).toBe(1);
    expect(runRepo.findByUuid('orphan-r1')?.status).toBe('failed');

    const orphanSweeper = new OrphanedRunsSweeper({
      runRepository: runRepo,
      leases,
      queue,
      eventBus,
      now: () => fixedNow,
      logger: { error: () => {} },
    });
    const orphanResult = await orphanSweeper.execute(sweepResult.orphanedRuns);
    expect(orphanResult.enqueued).toBe(1);
    expect(runRepo.findByUuid('orphan-r1')?.status).toBe('running');

    await workerLoop(serveWorkerId, {
      registry,
      queue,
      leases,
      repos,
      executeRun: async () => ({ ok: true }),
      prepareWorktree: async () => ({ cwd: '/tmp/wt' }),
      resetWorktree: () => {},
      isWorkerAlive: () => true,
      now: () => fixedNow,
      ttlMs: 60_000,
      findRun: (runId) => runRepo.findByUuid(runId),
      recoverableRunIds: new Set(),
    });

    const jobs = queue.listForRun('orphan-r1' as never);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe('succeeded');
  });

  it('AC2: a run whose lease is held by a live worker is never swept by the orphan sweeper', async () => {
    const crashed = createRun({
      uuid: 'orphan-r2',
      displayId: 'issue-7-20260710-000000',
      repoId,
      issueNumber: 7,
      startedAt: new Date('2026-07-09T00:00:00Z'),
    });
    runRepo.addRun({ ...crashed, pid: 55555 });
    leases.acquire({
      repoId,
      workerId: WorkerId('cli-other'),
      runId: 'orphan-r2' as never,
      now: fixedNow,
      ttlMs: 60_000,
    });

    const sweep = new SweepOrphanedRuns({
      runRepository: runRepo,
      isProcessAlive: (pid) => pid !== 55555,
      now: () => fixedNow,
    });
    const sweepResult = sweep.execute();
    expect(sweepResult.swept).toBe(1);

    const orphanSweeper = new OrphanedRunsSweeper({
      runRepository: runRepo,
      leases,
      queue,
      eventBus,
      now: () => fixedNow,
      logger: { error: () => {} },
    });
    const orphanResult = await orphanSweeper.execute(sweepResult.orphanedRuns);
    expect(orphanResult.enqueued).toBe(0);
    expect(orphanResult.skippedLeaseConflict).toBe(1);
    expect(runRepo.findByUuid('orphan-r2')?.status).toBe('failed');
    expect(queue.listForRun('orphan-r2' as never)).toHaveLength(0);
  });
});
