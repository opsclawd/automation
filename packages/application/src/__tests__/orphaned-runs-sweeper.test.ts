import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRun, RepositoryId, WorkerId, failRun } from '@ai-sdlc/domain';
import { OrphanedRunsSweeper } from '../orphaned-runs-sweeper.js';
import { FakeRunRepository } from '../test-doubles/fake-run-repository.js';
import { FakeJobQueuePort } from '../test-doubles/fake-job-queue-port.js';
import { FakeWorkerLeasePort } from '../test-doubles/fake-worker-lease-port.js';
import { FakeWorkerRegistryPort } from '../test-doubles/fake-worker-registry-port.js';
import { FakeRepositoryPort } from '../test-doubles/fake-repository-port.js';
import { FakeEventBus } from '../test-doubles/fake-event-bus.js';

const fixedNow = new Date('2026-07-10T00:00:00Z');
const repoId = RepositoryId('owner/repo');

function makeFailedRun(uuid: string, completedPhases: string[] = []) {
  const run = createRun({
    uuid,
    displayId: `issue-${uuid}-20260710-000000`,
    repoId,
    issueNumber: 1,
    startedAt: new Date('2026-07-09T00:00:00Z'),
  });
  return failRun(
    {
      ...run,
      completedPhases,
    },
    'orphaned: process 99999 no longer running',
    fixedNow,
  );
}

describe('OrphanedRunsSweeper', () => {
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
  });

  it('enqueues a job and transitions failed to running for each orphaned run', async () => {
    const failed = makeFailedRun('o1');
    runRepo.addRun(failed);

    const sweeper = new OrphanedRunsSweeper({
      runRepository: runRepo,
      leases,
      queue,
      eventBus,
      now: () => fixedNow,
      logger: { error: () => {} },
    });

    const result = await sweeper.execute([{ uuid: 'o1', run: failed, previousPid: 99999 }]);

    expect(result.enqueued).toBe(1);
    expect(result.skippedLeaseConflict).toBe(0);
    expect(result.enqueueErrors).toEqual([]);
    expect(queue.listForRun('o1' as never)).toHaveLength(1);
    expect(runRepo.findByUuid('o1')?.status).toBe('running');
    // Lease released so a worker can re-acquire it
    expect(leases.current(repoId)).toBeUndefined();
  });

  it('skips runs whose lease is held by another worker', async () => {
    const failed = makeFailedRun('o2');
    runRepo.addRun(failed);
    leases.acquire({
      repoId,
      workerId: WorkerId('other-worker'),
      runId: 'o2' as never,
      now: fixedNow,
      ttlMs: 60_000,
    });

    const sweeper = new OrphanedRunsSweeper({
      runRepository: runRepo,
      leases,
      queue,
      eventBus,
      now: () => fixedNow,
      logger: { error: () => {} },
    });

    const result = await sweeper.execute([{ uuid: 'o2', run: failed, previousPid: 99999 }]);

    expect(result.enqueued).toBe(0);
    expect(result.skippedLeaseConflict).toBe(1);
    expect(result.enqueueErrors).toEqual([]);
    expect(runRepo.findByUuid('o2')?.status).toBe('failed');
    expect(queue.listForRun('o2' as never)).toHaveLength(0);
  });

  it('skips runs whose lease acquire throws a non-conflict error', async () => {
    const failed = makeFailedRun('o3');
    runRepo.addRun(failed);
    vi.spyOn(leases, 'acquire').mockImplementationOnce(() => {
      throw new Error('lease DB unavailable');
    });

    const sweeper = new OrphanedRunsSweeper({
      runRepository: runRepo,
      leases,
      queue,
      eventBus,
      now: () => fixedNow,
      logger: { error: () => {} },
    });

    const result = await sweeper.execute([{ uuid: 'o3', run: failed, previousPid: 99999 }]);

    expect(result.enqueued).toBe(0);
    expect(result.skippedLeaseConflict).toBe(0);
    expect(result.enqueueErrors).toHaveLength(1);
    expect(result.enqueueErrors[0]!.error).toBe('lease DB unavailable');
    expect(runRepo.findByUuid('o3')?.status).toBe('failed');
  });

  it('does not enqueue if a run already has an active job', async () => {
    const failed = makeFailedRun('o4');
    runRepo.addRun(failed);
    // Pre-existing active job for the same runId (simulating a re-enqueue attempt)
    vi.spyOn(queue, 'listActive').mockReturnValueOnce([
      {
        id: 'existing-job' as never,
        runId: 'o4' as never,
        repoId,
        issueNumber: 1,
        priority: 10,
        status: 'queued',
        createdAt: fixedNow,
      } as never,
    ]);

    const sweeper = new OrphanedRunsSweeper({
      runRepository: runRepo,
      leases,
      queue,
      eventBus,
      now: () => fixedNow,
      logger: { error: () => {} },
    });

    const result = await sweeper.execute([{ uuid: 'o4', run: failed, previousPid: 99999 }]);

    expect(result.enqueued).toBe(0);
    expect(result.skippedAlreadyQueued).toBe(1);
    expect(runRepo.findByUuid('o4')?.status).toBe('failed');
  });

  it('rolls back status to failed when enqueue throws after the status flip', async () => {
    const failed = makeFailedRun('o5');
    runRepo.addRun(failed);
    vi.spyOn(queue, 'enqueue').mockImplementationOnce(() => {
      throw new Error('enqueue DB write failed');
    });

    const sweeper = new OrphanedRunsSweeper({
      runRepository: runRepo,
      leases,
      queue,
      eventBus,
      now: () => fixedNow,
      logger: { error: () => {} },
    });

    const result = await sweeper.execute([{ uuid: 'o5', run: failed, previousPid: 99999 }]);

    expect(result.enqueued).toBe(0);
    expect(result.enqueueErrors).toHaveLength(1);
    expect(result.enqueueErrors[0]!.error).toBe('enqueue DB write failed');
    expect(runRepo.findByUuid('o5')?.status).toBe('failed');
  });
});
