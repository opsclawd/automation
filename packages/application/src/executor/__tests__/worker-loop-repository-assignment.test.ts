import { describe, it, expect } from 'vitest';
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
      id: REPO_ID,
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
      id: OTHER_REPO_ID,
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
  currentQueue = queue;
  const registry = new FakeWorkerRegistryPort();
  const leases = new FakeWorkerLeasePort(registry);
  const now = new Date();
  registry.register(
    createWorker({ id: WorkerId('w1'), repoId: REPO_ID, hostname: 'h', processId: 1, now }),
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

describe('worker registration and heartbeat retain the assigned repository id', () => {
  it('worker registered with repoId r1 keeps repoId r1 after heartbeat', async () => {
    const s = setup();
    const later = new Date(s.now.getTime() + 60_000);

    s.registry.heartbeat(WorkerId('w1'), REPO_ID, later);

    const found = s.registry.findById(WorkerId('w1'), REPO_ID);
    expect(found?.repoId).toBe(REPO_ID);
    expect(found?.heartbeatAt).toEqual(later);
  });

  it('worker registered with repoId r1 keeps repoId r1 after status changes', async () => {
    const s = setup();

    s.registry.markBusy(WorkerId('w1'), REPO_ID);
    expect(s.registry.findById(WorkerId('w1'), REPO_ID)?.status).toBe('busy');
    expect(s.registry.findById(WorkerId('w1'), REPO_ID)?.repoId).toBe(REPO_ID);

    s.registry.markIdle(WorkerId('w1'), REPO_ID);
    expect(s.registry.findById(WorkerId('w1'), REPO_ID)?.status).toBe('idle');
    expect(s.registry.findById(WorkerId('w1'), REPO_ID)?.repoId).toBe(REPO_ID);
  });
});

describe('worker loop rejects a claimed job outside its repository assignment', () => {
  it('worker loop does not acquire a job for a different repository', async () => {
    const s = setup();
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
      registry: s.registry,
      queue: s.queue,
      leases: s.leases,
      repos: s.repos,
      repoId: REPO_ID,
      executeRun: executeOk,
      prepareWorktree: prepareOk,
      resetWorktree: (_repoId: import('@ai-sdlc/domain').RepositoryId) => {},
      isWorkerAlive: (_workerId: import('@ai-sdlc/domain').WorkerId) => true,
      recoverableRunIds: new Set([RunId('run-1')]),
      now: () => new Date(),
      ttlMs: 60_000,
      findRun: (runId: import('@ai-sdlc/domain').RunId) => makeRun(runId as string, OTHER_REPO_ID),
    });

    const job = s.queue.findById(JobId('j1'));
    expect(job!.status).toBe('queued');
    expect(s.leases.current(OTHER_REPO_ID)).toBeUndefined();
  });

  it('worker loop skips job for wrong repo and continues searching within assigned repo', async () => {
    const s = setup();
    s.queue.enqueue({
      job: createJob({
        id: JobId('j1'),
        runId: RunId('run-1'),
        repoId: OTHER_REPO_ID,
        issueNumber: IssueNumber(1),
        createdAt: s.now,
      }),
    });
    s.queue.enqueue({
      job: createJob({
        id: JobId('j2'),
        runId: RunId('run-2'),
        repoId: REPO_ID,
        issueNumber: IssueNumber(2),
        createdAt: new Date(s.now.getTime() + 1000),
      }),
    });

    await workerLoop(WorkerId('w1'), {
      registry: s.registry,
      queue: s.queue,
      leases: s.leases,
      repos: s.repos,
      repoId: REPO_ID,
      executeRun: executeOk,
      prepareWorktree: prepareOk,
      resetWorktree: (_repoId: import('@ai-sdlc/domain').RepositoryId) => {},
      isWorkerAlive: (_workerId: import('@ai-sdlc/domain').WorkerId) => true,
      recoverableRunIds: new Set([RunId('run-1'), RunId('run-2')]),
      now: () => new Date(),
      ttlMs: 60_000,
      findRun: (runId: import('@ai-sdlc/domain').RunId) => makeRun(runId as string),
    });

    expect(s.queue.findById(JobId('j1'))!.status).toBe('queued');
    expect(s.queue.findById(JobId('j2'))!.status).toBe('succeeded');
    expect(s.leases.current(REPO_ID)).toBeUndefined();
  });
});

describe('stale lease heartbeat cannot extend a reassigned run lease', () => {
  it('heartbeat with stale runId does not modify the current lease', () => {
    const { leases } = setup();
    const now = new Date();
    leases.acquire({
      repoId: REPO_ID,
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now,
      ttlMs: 60_000,
    });
    const afterExpiry = new Date(now.getTime() + 120_000);
    leases.acquire({
      repoId: REPO_ID,
      workerId: WorkerId('w2'),
      runId: RunId('run-2'),
      now: afterExpiry,
      ttlMs: 60_000,
    });
    const staleHeartbeatAt = new Date(afterExpiry.getTime() + 1000);
    leases.heartbeat({
      repoId: REPO_ID,
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: staleHeartbeatAt,
      newExpiresAt: new Date(staleHeartbeatAt.getTime() + 60_000),
    });
    const afterLease = leases.current(REPO_ID);
    expect(afterLease?.workerId).toBe(WorkerId('w2'));
    expect(afterLease?.runId).toBe(RunId('run-2'));
  });
});

describe('stale lease release cannot delete a reassigned run lease', () => {
  it('release with stale runId is a no-op', () => {
    const { leases } = setup();
    const now = new Date();
    leases.acquire({
      repoId: REPO_ID,
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now,
      ttlMs: 60_000,
    });
    const afterExpiry = new Date(now.getTime() + 120_000);
    leases.acquire({
      repoId: REPO_ID,
      workerId: WorkerId('w2'),
      runId: RunId('run-2'),
      now: afterExpiry,
      ttlMs: 60_000,
    });
    leases.release({
      repoId: REPO_ID,
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
    });
    const currentLease = leases.current(REPO_ID);
    expect(currentLease?.workerId).toBe(WorkerId('w2'));
    expect(currentLease?.runId).toBe(RunId('run-2'));
  });
});
