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

const REPO_ID = RepositoryId('r1');
const OTHER_REPO_ID = RepositoryId('r2');

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
  registry.register(
    createWorker({ id: WorkerId('w1'), repoId: REPO_ID, hostname: 'h', processId: 1, now }),
  );
  registry.register(
    createWorker({ id: WorkerId('w2'), repoId: OTHER_REPO_ID, hostname: 'h', processId: 2, now }),
  );
  return { repos, queue, registry, leases, now };
}

const executeOk = async (_input: {
  run: Run;
  workerId: WorkerId;
  cwd: string;
  signal: AbortSignal;
}) => ({ ok: true as const });
const prepareOk = async (_input: { repoId: RepositoryId; runId: RunId; signal: AbortSignal }) => ({
  cwd: '/tmp/worktree',
});

function makeRun(runId: string, repoId: RepositoryId = REPO_ID): Run {
  return createRun({
    uuid: runId,
    displayId: `disp-${runId}`,
    repoId,
    issueNumber: IssueNumber(1),
    startedAt: new Date(),
  });
}

function makeDeps(s: ReturnType<typeof setup>, workerId: WorkerId, repoId: RepositoryId) {
  return {
    registry: s.registry,
    queue: s.queue,
    leases: s.leases,
    repos: s.repos,
    repoId,
    executeRun: executeOk,
    prepareWorktree: prepareOk,
    resetWorktree: (_repoId: import('@ai-sdlc/domain').RepositoryId) => {},
    isWorkerAlive: (_workerId: import('@ai-sdlc/domain').WorkerId) => true,
    recoverableRunIds: new Set<RunId>(),
    now: () => new Date(),
    ttlMs: 60_000,
    findRun: (runId: import('@ai-sdlc/domain').RunId) => makeRun(runId as string, repoId),
  };
}

describe('workerLoop repository assignment', () => {
  // Test repository isolation and worker assignment
  it('worker loop rejects a claimed job outside its repository assignment', async () => {
    const s = setup();
    const prepareWorktree = vi.fn(prepareOk);
    const executeRun = vi.fn(executeOk);

    s.queue.enqueue({
      job: createJob({
        id: JobId('j1'),
        runId: RunId('run-1'),
        repoId: OTHER_REPO_ID,
        issueNumber: IssueNumber(1),
        createdAt: s.now,
      }),
    });

    await workerLoop(WorkerId('w1'), {
      ...makeDeps(s, WorkerId('w1'), REPO_ID),
      repoId: REPO_ID,
      prepareWorktree,
      executeRun,
      recoverableRunIds: new Set([RunId('run-1')]),
    });

    expect(prepareWorktree).not.toHaveBeenCalled();
    expect(executeRun).not.toHaveBeenCalled();
    expect(s.queue.findById(JobId('j1'))?.status).toBe('queued');
  });

  it('worker loop accepts a job within its repository assignment', async () => {
    const s = setup();

    s.queue.enqueue({
      job: createJob({
        id: JobId('j1'),
        runId: RunId('run-1'),
        repoId: REPO_ID,
        issueNumber: IssueNumber(1),
        createdAt: s.now,
      }),
    });

    await workerLoop(WorkerId('w1'), {
      ...makeDeps(s, WorkerId('w1'), REPO_ID),
      recoverableRunIds: new Set([RunId('run-1')]),
    });

    expect(s.queue.findById(JobId('j1'))?.status).toBe('succeeded');
  });

  it('worker registered to one repo cannot heartbeat a lease for another repo', async () => {
    const s = setup();

    s.leases.acquire({
      repoId: OTHER_REPO_ID,
      workerId: WorkerId('w2'),
      runId: RunId('run-1'),
      now: s.now,
      ttlMs: 60_000,
    });

    await workerLoop(WorkerId('w1'), {
      ...makeDeps(s, WorkerId('w1'), REPO_ID),
      recoverableRunIds: new Set([RunId('run-1')]),
    });

    const lease = s.leases.current(OTHER_REPO_ID);
    expect(lease?.workerId).toBe('w2');
    expect(lease?.runId).toBe('run-1');
  });

  it('stale lease heartbeat cannot extend a reassigned run lease', async () => {
    const s = setup();
    const now = s.now;

    const w1Lease = s.leases.acquire({
      repoId: REPO_ID,
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now,
      ttlMs: 60_000,
    });

    const later = new Date(now.getTime() + 120_000);
    s.leases.release({
      repoId: REPO_ID,
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      leaseToken: w1Lease.leaseToken,
    });
    s.leases.acquire({
      repoId: REPO_ID,
      workerId: WorkerId('w2'),
      runId: RunId('run-2'),
      now: later,
      ttlMs: 60_000,
    });

    expect(() =>
      s.leases.heartbeat({
        repoId: REPO_ID,
        workerId: WorkerId('w1'),
        runId: RunId('run-1'),
        now: later,
        newExpiresAt: new Date(later.getTime() + 60_000),
        leaseToken: w1Lease.leaseToken,
      }),
    ).toThrow('WorkerLease ownership lost');

    const currentLease = s.leases.current(REPO_ID);
    expect(currentLease?.workerId).toBe('w2');
    expect(currentLease?.runId).toBe('run-2');
  });

  it('stale lease release cannot delete a reassigned run lease', async () => {
    const s = setup();
    const now = s.now;

    const w1Lease = s.leases.acquire({
      repoId: REPO_ID,
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now,
      ttlMs: 60_000,
    });

    const later = new Date(now.getTime() + 120_000);
    s.leases.release({
      repoId: REPO_ID,
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      leaseToken: w1Lease.leaseToken,
    });
    s.leases.acquire({
      repoId: REPO_ID,
      workerId: WorkerId('w2'),
      runId: RunId('run-2'),
      now: later,
      ttlMs: 60_000,
    });

    expect(() =>
      s.leases.release({
        repoId: REPO_ID,
        workerId: WorkerId('w1'),
        runId: RunId('run-1'),
        leaseToken: w1Lease.leaseToken,
      }),
    ).toThrow('WorkerLease ownership lost');

    const currentLease = s.leases.current(REPO_ID);
    expect(currentLease?.workerId).toBe('w2');
    expect(currentLease?.runId).toBe('run-2');
  });
});
