import { describe, it, expect, vi } from 'vitest';
import {
  createWorker,
  IssueNumber,
  JobId,
  RepositoryId,
  RunId,
  WorkerId,
  createJob,
  createRun,
  type Run,
} from '@ai-sdlc/domain';
import {
  FakeRepositoryPort,
  FakeJobQueuePort,
  FakeWorkerRegistryPort,
  FakeWorkerLeasePort,
} from '../../test-doubles/index.js';
import { workerLoop } from '../worker-loop.js';

function setup() {
  const repos = new FakeRepositoryPort([
    {
      id: RepositoryId('r1'),
      owner: 'o',
      name: 'r1',
      fullName: 'o/r1',
      defaultBranch: 'main',
      localBasePath: '/x',
      enabled: true,
      maxConcurrentRuns: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: RepositoryId('r2'),
      owner: 'o',
      name: 'r2',
      fullName: 'o/r2',
      defaultBranch: 'main',
      localBasePath: '/y',
      enabled: true,
      maxConcurrentRuns: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);
  const queue = new FakeJobQueuePort(repos);
  const registry = new FakeWorkerRegistryPort();
  const leases = new FakeWorkerLeasePort(registry);
  const now = new Date();
  registry.register(createWorker({ id: WorkerId('w1'), hostname: 'h', processId: 1, now }));
  registry.register(createWorker({ id: WorkerId('w2'), hostname: 'h', processId: 2, now }));
  return { repos, queue, registry, leases, now };
}

const executeOk = async (_input: {
  run: Run;
  workerId: WorkerId;
  cwd: string;
  signal: AbortSignal;
}) => ({ ok: true as const });
const executeThrow = async () => {
  throw new Error('executeRun crashed');
};
const prepareOk = async () => ({ cwd: '/tmp/worktree' });

function makeRun(runId: string): Run {
  return createRun({
    uuid: runId,
    displayId: runId,
    issueNumber: IssueNumber(1),
    startedAt: new Date(),
  });
}

describe('workerLoop', () => {
  it('two queued jobs on the same repo: serializes execution (one at a time)', async () => {
    const s = setup();
    s.queue.enqueue({
      job: createJob({
        id: JobId('j1'),
        runId: RunId('run-1'),
        repoId: RepositoryId('r1'),
        issueNumber: IssueNumber(1),
        createdAt: s.now,
      }),
    });
    s.queue.enqueue({
      job: createJob({
        id: JobId('j2'),
        runId: RunId('run-2'),
        repoId: RepositoryId('r1'),
        issueNumber: IssueNumber(2),
        createdAt: new Date(s.now.getTime() + 1000),
      }),
    });

    const deps = {
      ...s,
      executeRun: executeOk,
      prepareWorktree: prepareOk,
      resetWorktree: (_repoId: import('@ai-sdlc/domain').RepositoryId) => {},
      isWorkerAlive: (_workerId: import('@ai-sdlc/domain').WorkerId) => true,
      recoverableRunIds: new Set([RunId('run-1'), RunId('run-2')]),
      now: () => new Date(),
      ttlMs: 60_000,
      findRun: (runId: import('@ai-sdlc/domain').RunId) => makeRun(runId as string),
    };

    await workerLoop(WorkerId('w1'), deps);
    expect(s.queue.findById(JobId('j1'))!.status).toBe('succeeded');
    expect(s.leases.current(RepositoryId('r1'))).toBeUndefined();

    await workerLoop(WorkerId('w2'), deps);
    expect(s.queue.findById(JobId('j2'))!.status).toBe('succeeded');
    expect(s.leases.current(RepositoryId('r1'))).toBeUndefined();
  });

  it('two queued jobs on different repos: both run concurrently', async () => {
    const s = setup();
    s.queue.enqueue({
      job: createJob({
        id: JobId('j1'),
        runId: RunId('run-1'),
        repoId: RepositoryId('r1'),
        issueNumber: IssueNumber(1),
        createdAt: s.now,
      }),
    });
    s.queue.enqueue({
      job: createJob({
        id: JobId('j2'),
        runId: RunId('run-2'),
        repoId: RepositoryId('r2'),
        issueNumber: IssueNumber(2),
        createdAt: s.now,
      }),
    });

    const deps = {
      registry: s.registry,
      queue: s.queue,
      leases: s.leases,
      repos: s.repos,
      executeRun: executeOk,
      prepareWorktree: prepareOk,
      resetWorktree: (_repoId: import('@ai-sdlc/domain').RepositoryId) => {},
      isWorkerAlive: (_workerId: import('@ai-sdlc/domain').WorkerId) => true,
      recoverableRunIds: new Set([RunId('run-1'), RunId('run-2')]),
      now: () => new Date(),
      ttlMs: 60_000,
      findRun: (runId: import('@ai-sdlc/domain').RunId) => makeRun(runId as string),
    };

    await Promise.all([workerLoop(WorkerId('w1'), deps), workerLoop(WorkerId('w2'), deps)]);

    expect(s.queue.findById(JobId('j1'))!.status).toBe('succeeded');
    expect(s.queue.findById(JobId('j2'))!.status).toBe('succeeded');
    expect(s.leases.current(RepositoryId('r1'))).toBeUndefined();
    expect(s.leases.current(RepositoryId('r2'))).toBeUndefined();
  });

  it('executeRun throws: lease is always released and job marked failed', async () => {
    const s = setup();
    s.queue.enqueue({
      job: createJob({
        id: JobId('j1'),
        runId: RunId('run-1'),
        repoId: RepositoryId('r1'),
        issueNumber: IssueNumber(1),
        createdAt: s.now,
      }),
    });

    await workerLoop(WorkerId('w1'), {
      registry: s.registry,
      queue: s.queue,
      leases: s.leases,
      repos: s.repos,
      executeRun: executeThrow,
      prepareWorktree: prepareOk,
      resetWorktree: (_repoId) => {},
      isWorkerAlive: (_workerId) => true,
      recoverableRunIds: new Set([RunId('run-1')]),
      now: () => new Date(),
      ttlMs: 60_000,
      findRun: (runId) => makeRun(runId as string),
    });

    expect(s.leases.current(RepositoryId('r1'))).toBeUndefined();
    expect(s.queue.findById(JobId('j1'))!.status).toBe('failed');
  });

  it('heartbeat failure during executeRun fails the job immediately', async () => {
    const s = setup();
    s.queue.enqueue({
      job: createJob({
        id: JobId('j1'),
        runId: RunId('run-1'),
        repoId: RepositoryId('r1'),
        issueNumber: IssueNumber(1),
        createdAt: s.now,
      }),
    });

    vi.spyOn(s.leases, 'heartbeat').mockImplementation(() => {
      throw new Error('heartbeat failed');
    });

    await workerLoop(WorkerId('w1'), {
      registry: s.registry,
      queue: s.queue,
      leases: s.leases,
      repos: s.repos,
      executeRun: async ({ signal }) => {
        await new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(new Error('heartbeat failed during job execution'));
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              reject(new Error('heartbeat failed during job execution'));
            },
            { once: true },
          );
        });
        return { ok: true };
      },
      prepareWorktree: prepareOk,
      resetWorktree: (_repoId) => {},
      isWorkerAlive: (_workerId) => true,
      recoverableRunIds: new Set([RunId('run-1')]),
      now: () => new Date(),
      ttlMs: 10,
      findRun: (runId) => makeRun(runId as string),
    });

    expect(s.queue.findById(JobId('j1'))!.status).toBe('failed');
    expect(s.leases.current(RepositoryId('r1'))).toBeUndefined();
  }, 10_000);

  it('WorkerLeaseConflictError caught: worker skips job without crashing', async () => {
    const s = setup();
    s.queue.enqueue({
      job: createJob({
        id: JobId('j1'),
        runId: RunId('run-1'),
        repoId: RepositoryId('r1'),
        issueNumber: IssueNumber(1),
        createdAt: s.now,
      }),
    });

    // Pre-acquire the lease so workerLoop's acquire will conflict
    s.leases.acquire({
      repoId: RepositoryId('r1'),
      workerId: WorkerId('w2'),
      runId: RunId('run-1'),
      now: s.now,
      ttlMs: 60_000,
    });

    await workerLoop(WorkerId('w1'), {
      registry: s.registry,
      queue: s.queue,
      leases: s.leases,
      repos: s.repos,
      executeRun: executeOk,
      prepareWorktree: prepareOk,
      resetWorktree: (_repoId) => {},
      isWorkerAlive: (_workerId) => true,
      recoverableRunIds: new Set([RunId('run-1')]),
      now: () => new Date(),
      ttlMs: 60_000,
      findRun: (runId) => makeRun(runId as string),
    });

    const job = s.queue.findById(JobId('j1'));
    expect(job).toBeDefined();
    expect(job!.status).toBe('queued');
    expect(s.leases.current(RepositoryId('r1'))?.workerId).toBe('w2');
  });

  it('does not release a pre-existing lease held by the same worker on acquire conflict', async () => {
    const s = setup();
    // Simulate a worker restart: w1 already holds an unexpired lease on r1 for a
    // prior run (e.g. the process restarted and re-registered as idle before its
    // previous lease was reclaimed).
    s.leases.acquire({
      repoId: RepositoryId('r1'),
      workerId: WorkerId('w1'),
      runId: RunId('run-old'),
      now: s.now,
      ttlMs: 60_000,
    });

    // A fresh job for the same repo is queued; w1 will claim it and conflict on
    // acquire because it still holds the prior (unexpired) lease.
    s.queue.enqueue({
      job: createJob({
        id: JobId('j1'),
        runId: RunId('run-1'),
        repoId: RepositoryId('r1'),
        issueNumber: IssueNumber(1),
        createdAt: s.now,
      }),
    });

    await workerLoop(WorkerId('w1'), {
      registry: s.registry,
      queue: s.queue,
      leases: s.leases,
      repos: s.repos,
      executeRun: executeOk,
      prepareWorktree: prepareOk,
      resetWorktree: (_repoId) => {},
      isWorkerAlive: (_workerId) => true,
      recoverableRunIds: new Set([RunId('run-old'), RunId('run-1')]),
      now: () => s.now, // keep the prior lease unexpired
      ttlMs: 60_000,
      findRun: (runId) => makeRun(runId as string),
    });

    // The new job is released back to queued (conflict), and crucially the prior
    // lease this tick did NOT acquire must be preserved — not dropped by finally.
    expect(s.queue.findById(JobId('j1'))!.status).toBe('queued');
    const lease = s.leases.current(RepositoryId('r1'));
    expect(lease?.workerId).toBe('w1');
    expect(lease?.runId).toBe('run-old');
  });

  it('reclaimExpired recovers a dead worker lease so new worker can proceed', async () => {
    const s = setup();
    const onLeaseReclaimed = vi.fn();
    // Register w3 and mark it stopping
    s.registry.register(
      createWorker({ id: WorkerId('w3'), hostname: 'h', processId: 3, now: s.now }),
    );
    s.registry.markBusy(WorkerId('w3'));

    // Give w1 a lease that we will make "expired" by advancing time
    const lease = s.leases.acquire({
      repoId: RepositoryId('r1'),
      workerId: WorkerId('w1'),
      runId: RunId('run-old'),
      now: s.now,
      ttlMs: 60_000,
    });
    s.registry.markStopping(WorkerId('w1'));

    const lateNow = new Date(lease.expiresAt.getTime() + 1000);

    s.queue.enqueue({
      job: createJob({
        id: JobId('j1'),
        runId: RunId('run-1'),
        repoId: RepositoryId('r1'),
        issueNumber: IssueNumber(1),
        createdAt: lateNow,
      }),
    });

    await workerLoop(WorkerId('w2'), {
      registry: s.registry,
      queue: s.queue,
      leases: s.leases,
      repos: s.repos,
      executeRun: executeOk,
      prepareWorktree: prepareOk,
      resetWorktree: (_repoId) => {},
      isWorkerAlive: (_workerId) => false, // w1 is not alive
      recoverableRunIds: new Set([RunId('run-old')]),
      now: () => lateNow,
      ttlMs: 60_000,
      findRun: (runId) => makeRun(runId as string),
      onLeaseReclaimed,
    });

    expect(s.queue.findById(JobId('j1'))!.status).toBe('succeeded');
    expect(s.leases.current(RepositoryId('r1'))).toBeUndefined();
    expect(onLeaseReclaimed).toHaveBeenCalledWith({
      repoId: RepositoryId('r1'),
      previousWorkerId: WorkerId('w1'),
      previousRunId: RunId('run-old'),
      reclaimedByWorkerId: WorkerId('w2'),
      reason: 'expired + worker stale + run recoverable',
    });
  });

  it('requeues reclaimed lease job left in running state by crashed worker', async () => {
    const s = setup();

    // Create a job for run-old and simulate w1 having marked it running before crashing
    s.queue.enqueue({
      job: createJob({
        id: JobId('j-old'),
        runId: RunId('run-old'),
        repoId: RepositoryId('r1'),
        issueNumber: IssueNumber(1),
        createdAt: s.now,
      }),
    });
    // Advance job through claimed→running (w1 crashed after markRunning)
    s.queue.claimNext({ workerId: WorkerId('w1') });
    s.queue.markRunning(JobId('j-old'), s.now);

    // Give w1 a lease that expired
    const lease = s.leases.acquire({
      repoId: RepositoryId('r1'),
      workerId: WorkerId('w1'),
      runId: RunId('run-old'),
      now: s.now,
      ttlMs: 60_000,
    });

    const lateNow = new Date(lease.expiresAt.getTime() + 1000);

    await workerLoop(WorkerId('w2'), {
      registry: s.registry,
      queue: s.queue,
      leases: s.leases,
      repos: s.repos,
      executeRun: executeOk,
      prepareWorktree: prepareOk,
      resetWorktree: (_repoId) => {},
      isWorkerAlive: () => false,
      recoverableRunIds: new Set([RunId('run-old')]),
      now: () => lateNow,
      ttlMs: 60_000,
      findRun: (runId) => makeRun(runId as string),
    });

    // The old job was requeued then claimed+executed by w2
    expect(s.queue.findById(JobId('j-old'))!.status).toBe('succeeded');
    expect(s.leases.current(RepositoryId('r1'))).toBeUndefined();
  });

  it('skips lease-conflicted repo job and runs next claimable job from different repo', async () => {
    const s = setup();
    // r1 is busy — another worker holds the lease
    s.leases.acquire({
      repoId: RepositoryId('r1'),
      workerId: WorkerId('w2'),
      runId: RunId('run-0'),
      now: s.now,
      ttlMs: 60_000,
    });

    // Oldest queued job is for r1 (blocked), next is for r2 (claimable)
    s.queue.enqueue({
      job: createJob({
        id: JobId('j1'),
        runId: RunId('run-1'),
        repoId: RepositoryId('r1'),
        issueNumber: IssueNumber(1),
        createdAt: s.now,
      }),
    });
    s.queue.enqueue({
      job: createJob({
        id: JobId('j2'),
        runId: RunId('run-2'),
        repoId: RepositoryId('r2'),
        issueNumber: IssueNumber(2),
        createdAt: new Date(s.now.getTime() + 1000),
      }),
    });

    await workerLoop(WorkerId('w1'), {
      registry: s.registry,
      queue: s.queue,
      leases: s.leases,
      repos: s.repos,
      executeRun: executeOk,
      prepareWorktree: prepareOk,
      resetWorktree: (_repoId) => {},
      isWorkerAlive: (_workerId) => true,
      recoverableRunIds: new Set([RunId('run-1'), RunId('run-2')]),
      now: () => new Date(),
      ttlMs: 60_000,
      findRun: (runId) => makeRun(runId as string),
    });

    // j1 was released back to queued (r1 lease still held by w2)
    expect(s.queue.findById(JobId('j1'))!.status).toBe('queued');
    // j2 was claimed and executed
    expect(s.queue.findById(JobId('j2'))!.status).toBe('succeeded');
    // r1 lease still belongs to original holder
    expect(s.leases.current(RepositoryId('r1'))?.workerId).toBe('w2');
    // r2 lease was released
    expect(s.leases.current(RepositoryId('r2'))).toBeUndefined();
  });

  it('no jobs available: returns without side effects', async () => {
    const s = setup();

    await workerLoop(WorkerId('w1'), {
      registry: s.registry,
      queue: s.queue,
      leases: s.leases,
      repos: s.repos,
      executeRun: executeOk,
      prepareWorktree: prepareOk,
      resetWorktree: (_repoId) => {},
      isWorkerAlive: (_workerId) => true,
      recoverableRunIds: new Set(),
      now: () => new Date(),
      ttlMs: 60_000,
      findRun: (runId) => makeRun(runId as string),
    });

    const w = s.registry.findById(WorkerId('w1'));
    expect(w!.status).toBe('idle');
  });

  it('reentrant call while worker is busy is rejected', async () => {
    const s = setup();
    s.registry.markBusy(WorkerId('w1'));

    await workerLoop(WorkerId('w1'), {
      registry: s.registry,
      queue: s.queue,
      leases: s.leases,
      repos: s.repos,
      executeRun: executeOk,
      prepareWorktree: prepareOk,
      resetWorktree: (_repoId) => {},
      isWorkerAlive: (_workerId) => true,
      recoverableRunIds: new Set(),
      now: () => new Date(),
      ttlMs: 60_000,
      findRun: (runId) => makeRun(runId as string),
    });

    expect(s.registry.findById(WorkerId('w1'))!.status).toBe('busy');
  });
});
