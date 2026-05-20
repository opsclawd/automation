import { describe, expect, it } from 'vitest';
import {
  createWorker,
  IssueNumber,
  JobId,
  RepositoryId,
  RunId,
  WorkerId,
  createJob,
  WorkerLeaseConflictError,
} from '@ai-sdlc/domain';
import {
  FakeRepositoryPort,
  FakeJobQueuePort,
  FakeWorkerRegistryPort,
  FakeWorkerLeasePort,
} from '../test-doubles/index.js';

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

describe('worker concurrency simulation', () => {
  it('two queued jobs on the same repo: workers serialise (one acquires, the other blocks)', () => {
    const { queue, leases, now } = setup();
    queue.enqueue({
      job: createJob({
        id: JobId('j1'),
        runId: RunId('run-1'),
        repoId: RepositoryId('r1'),
        issueNumber: IssueNumber(1),
        createdAt: now,
      }),
    });
    queue.enqueue({
      job: createJob({
        id: JobId('j2'),
        runId: RunId('run-2'),
        repoId: RepositoryId('r1'),
        issueNumber: IssueNumber(2),
        createdAt: new Date(now.getTime() + 1000),
      }),
    });
    const j1 = queue.claimNext({ workerId: WorkerId('w1') })!;
    leases.acquire({
      repoId: j1.repoId,
      workerId: WorkerId('w1'),
      runId: j1.runId,
      now,
      ttlMs: 60_000,
    });
    const j2 = queue.claimNext({ workerId: WorkerId('w2') })!;
    expect(() =>
      leases.acquire({
        repoId: j2.repoId,
        workerId: WorkerId('w2'),
        runId: j2.runId,
        now,
        ttlMs: 60_000,
      }),
    ).toThrow(WorkerLeaseConflictError);
  });

  it('two queued jobs on different repos: both workers run concurrently', () => {
    const { queue, leases, now } = setup();
    queue.enqueue({
      job: createJob({
        id: JobId('j1'),
        runId: RunId('run-1'),
        repoId: RepositoryId('r1'),
        issueNumber: IssueNumber(1),
        createdAt: now,
      }),
    });
    queue.enqueue({
      job: createJob({
        id: JobId('j2'),
        runId: RunId('run-2'),
        repoId: RepositoryId('r2'),
        issueNumber: IssueNumber(2),
        createdAt: now,
      }),
    });
    const j1 = queue.claimNext({ workerId: WorkerId('w1') })!;
    const j2 = queue.claimNext({ workerId: WorkerId('w2') })!;
    leases.acquire({
      repoId: j1.repoId,
      workerId: WorkerId('w1'),
      runId: j1.runId,
      now,
      ttlMs: 60_000,
    });
    leases.acquire({
      repoId: j2.repoId,
      workerId: WorkerId('w2'),
      runId: j2.runId,
      now,
      ttlMs: 60_000,
    });
    expect(leases.current(RepositoryId('r1'))?.workerId).toBe('w1');
    expect(leases.current(RepositoryId('r2'))?.workerId).toBe('w2');
  });
});
