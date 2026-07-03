import { describe, expect, it, vi, beforeEach } from 'vitest';
import { WorkerScheduler } from '../worker-scheduler.js';
import { workerLoop } from '@ai-sdlc/application';
import type { WorkerLoopDeps } from '@ai-sdlc/application';
import { WorkerId, JobId, RunId, RepositoryId, IssueNumber } from '@ai-sdlc/domain';
import type { JobQueuePort } from '@ai-sdlc/application/ports';
import type { RepositoryPort } from '@ai-sdlc/application/ports';

vi.mock('@ai-sdlc/application', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ai-sdlc/application')>();
  return { ...actual, workerLoop: vi.fn().mockResolvedValue(undefined) };
});

function makeJob(
  id: string,
  status: string,
  overrides: Partial<ReturnType<JobQueuePort['findById']>> = {},
): ReturnType<JobQueuePort['findById']> {
  return {
    id: JobId(id),
    status,
    runId: RunId('run-1'),
    repoId: RepositoryId('owner/repo'),
    issueNumber: IssueNumber(1),
    priority: 0,
    attempts: 0,
    createdAt: new Date(),
    ...overrides,
  } as unknown as ReturnType<JobQueuePort['findById']>;
}

function makeQueue(statuses: Record<string, string>): JobQueuePort {
  return {
    findById: vi.fn((jobId: JobId) => makeJob(jobId as string, statuses[jobId] ?? 'queued')),
    listForRepo: vi.fn(() => []),
    listForRun: vi.fn(() => []),
    enqueue: vi.fn(),
    claimNext: vi.fn(),
    releaseClaim: vi.fn(),
    resetToQueued: vi.fn(),
    markRunning: vi.fn(),
    markSucceeded: vi.fn(),
    markFailed: vi.fn(),
    markCancelled: vi.fn(),
    findExpiredClaims: vi.fn(() => []),
    reclaimStaleClaims: vi.fn(() => 0),
  };
}

function makeRepos(): RepositoryPort {
  return {
    findById: vi.fn(),
    findByFullName: vi.fn(),
    listEnabled: vi.fn(() => [{ id: RepositoryId('owner/repo') }]),
  } as unknown as RepositoryPort;
}

function makeBaseDeps(): Omit<WorkerLoopDeps, 'recoverableRunIds'> {
  return {
    registry: {
      findById: vi.fn(() => ({ status: 'idle' })),
      register: vi.fn(),
      heartbeat: vi.fn(),
      markBusy: vi.fn(),
      markIdle: vi.fn(),
      markStopping: vi.fn(),
      markUnhealthy: vi.fn(),
      list: vi.fn(() => []),
    },
    queue: makeQueue({}),
    leases: {} as WorkerLoopDeps['leases'],
    repos: makeRepos(),
    executeRun: vi.fn(),
    prepareWorktree: vi.fn(),
    resetWorktree: vi.fn(),
    isWorkerAlive: vi.fn(() => false),
    findRun: vi.fn(),
    now: () => new Date(),
    ttlMs: 120_000,
  } as unknown as Omit<WorkerLoopDeps, 'recoverableRunIds'>;
}

describe('WorkerScheduler', () => {
  beforeEach(() => {
    vi.mocked(workerLoop).mockClear();
  });

  it('returns immediately when job is already in terminal state (succeeded)', async () => {
    const queue = makeQueue({ 'job-1': 'succeeded' });
    const scheduler = new WorkerScheduler([WorkerId('w1')], { ...makeBaseDeps(), queue }, 0);
    await scheduler.runUntilComplete(JobId('job-1'), new AbortController().signal);
    expect(vi.mocked(workerLoop)).not.toHaveBeenCalled();
  });

  it('returns immediately when job is already failed', async () => {
    const queue = makeQueue({ 'job-1': 'failed' });
    const scheduler = new WorkerScheduler([WorkerId('w1')], { ...makeBaseDeps(), queue }, 0);
    await scheduler.runUntilComplete(JobId('job-1'), new AbortController().signal);
    expect(vi.mocked(workerLoop)).not.toHaveBeenCalled();
  });

  it('calls workerLoop for each workerId on each tick', async () => {
    let tick = 0;
    const queue: JobQueuePort = {
      ...makeQueue({}),
      findById: vi.fn(() => {
        tick++;
        return {
          id: JobId('job-1'),
          status: tick === 1 ? 'queued' : 'succeeded',
          runId: RunId('run-1'),
          repoId: RepositoryId('owner/repo'),
          issueNumber: IssueNumber(1),
          priority: 0,
          attempts: 0,
          createdAt: new Date(),
        } as unknown as ReturnType<JobQueuePort['findById']>;
      }),
      listForRepo: vi.fn(() => []),
    };
    const scheduler = new WorkerScheduler(
      [WorkerId('w1'), WorkerId('w2')],
      { ...makeBaseDeps(), queue },
      0,
    );
    await scheduler.runUntilComplete(JobId('job-1'), new AbortController().signal);
    expect(vi.mocked(workerLoop)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(workerLoop)).toHaveBeenCalledWith(
      WorkerId('w1'),
      expect.objectContaining({ recoverableRunIds: expect.any(Set) }),
    );
    expect(vi.mocked(workerLoop)).toHaveBeenCalledWith(
      WorkerId('w2'),
      expect.objectContaining({ recoverableRunIds: expect.any(Set) }),
    );
  });

  it('stops ticking when signal is aborted', async () => {
    const queue: JobQueuePort = {
      ...makeQueue({}),
      findById: vi.fn(
        () =>
          ({
            id: JobId('job-1'),
            status: 'queued',
            runId: RunId('run-1'),
            repoId: RepositoryId('owner/repo'),
            issueNumber: IssueNumber(1),
            priority: 0,
            attempts: 0,
            createdAt: new Date(),
          }) as unknown as ReturnType<JobQueuePort['findById']>,
      ),
      listForRepo: vi.fn(() => []),
    };
    const controller = new AbortController();
    vi.mocked(workerLoop).mockImplementation(async () => {
      controller.abort();
    });
    const scheduler = new WorkerScheduler([WorkerId('w1')], { ...makeBaseDeps(), queue }, 0);
    await scheduler.runUntilComplete(JobId('job-1'), controller.signal);
    expect(vi.mocked(workerLoop)).toHaveBeenCalledTimes(1);
  });

  it('throws when job is not found', async () => {
    const queue: JobQueuePort = {
      ...makeQueue({}),
      findById: vi.fn(() => undefined),
      listForRepo: vi.fn(() => []),
    };
    const scheduler = new WorkerScheduler([WorkerId('w1')], { ...makeBaseDeps(), queue }, 0);
    await expect(
      scheduler.runUntilComplete(JobId('missing'), new AbortController().signal),
    ).rejects.toThrow(/not found/);
  });

  it('passes recoverableRunIds built from non-terminal jobs', async () => {
    let tick = 0;
    const queue: JobQueuePort = {
      findById: vi.fn(
        () =>
          ({
            id: JobId('job-1'),
            status: tick++ === 0 ? 'queued' : 'succeeded',
            runId: RunId('run-1'),
            repoId: RepositoryId('owner/repo'),
            issueNumber: IssueNumber(1),
            priority: 0,
            attempts: 0,
            createdAt: new Date(),
          }) as unknown as ReturnType<JobQueuePort['findById']>,
      ),
      listForRepo: vi.fn(() => [
        {
          id: JobId('j2'),
          runId: RunId('run-2'),
          status: 'claimed',
          repoId: RepositoryId('owner/repo'),
          issueNumber: IssueNumber(2),
          priority: 0,
          attempts: 0,
          createdAt: new Date(),
        },
        {
          id: JobId('j3'),
          runId: RunId('run-3'),
          status: 'succeeded',
          repoId: RepositoryId('owner/repo'),
          issueNumber: IssueNumber(3),
          priority: 0,
          attempts: 0,
          createdAt: new Date(),
        },
      ]) as unknown as ReturnType<JobQueuePort['listForRepo']>,
      enqueue: vi.fn(),
      claimNext: vi.fn(),
      releaseClaim: vi.fn(),
      resetToQueued: vi.fn(),
      markRunning: vi.fn(),
      markSucceeded: vi.fn(),
      markFailed: vi.fn(),
      markCancelled: vi.fn(),
      listForRun: vi.fn(() => []),
      findExpiredClaims: vi.fn(() => []),
      reclaimStaleClaims: vi.fn(() => 0),
    };
    const scheduler = new WorkerScheduler([WorkerId('w1')], { ...makeBaseDeps(), queue }, 0);
    await scheduler.runUntilComplete(JobId('job-1'), new AbortController().signal);
    const callArgs = vi.mocked(workerLoop).mock.calls[0];
    const deps = callArgs?.[1] as WorkerLoopDeps;
    expect(deps.recoverableRunIds.has(RunId('run-2'))).toBe(true);
    expect(deps.recoverableRunIds.has(RunId('run-3'))).toBe(false);
  });

  it('throws error when a worker loop rejects', async () => {
    const queue = makeQueue({});
    const scheduler = new WorkerScheduler([WorkerId('w1')], { ...makeBaseDeps(), queue }, 0);
    vi.mocked(workerLoop).mockRejectedValueOnce(new Error('worker loop failure'));
    await expect(
      scheduler.runUntilComplete(JobId('job-1'), new AbortController().signal),
    ).rejects.toThrow('worker loop failure');
  });

  it('returns immediately when job is already cancelled', async () => {
    const queue = makeQueue({ 'job-1': 'cancelled' });
    const scheduler = new WorkerScheduler([WorkerId('w1')], { ...makeBaseDeps(), queue }, 0);
    await scheduler.runUntilComplete(JobId('job-1'), new AbortController().signal);
    expect(vi.mocked(workerLoop)).not.toHaveBeenCalled();
  });

  it('normalizes non-Error rejection to Error before throwing', async () => {
    const queue = makeQueue({});
    const scheduler = new WorkerScheduler([WorkerId('w1')], { ...makeBaseDeps(), queue }, 0);
    vi.mocked(workerLoop).mockRejectedValueOnce('plain string' as unknown as Error);
    await expect(
      scheduler.runUntilComplete(JobId('job-1'), new AbortController().signal),
    ).rejects.toThrow(/plain string/);
  });

  it('calls reclaimStaleClaims with a cutoff of now - 6*tick before each tick', async () => {
    const reclaimSpy = vi.fn(() => 0);
    let callCount = 0;
    const queue: JobQueuePort = {
      ...makeQueue({}),
      findById: vi.fn(() => {
        callCount++;
        return makeJob('job-1', callCount === 1 ? 'queued' : 'succeeded');
      }),
      reclaimStaleClaims: reclaimSpy,
    };
    const scheduler = new WorkerScheduler([WorkerId('w1')], { ...makeBaseDeps(), queue }, 100);
    await scheduler.runUntilComplete(JobId('job-1'), new AbortController().signal);
    expect(reclaimSpy).toHaveBeenCalled();
    const cutoff = reclaimSpy.mock.calls[0]?.[0] as Date;
    const expected = Date.now() - 600;
    expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(200);
  });

  it('releases claim when signal aborts while job is claimed', async () => {
    const releaseSpy = vi.fn();
    const queue: JobQueuePort = {
      ...makeQueue({}),
      findById: vi.fn(() => makeJob('job-1', 'claimed')),
      releaseClaim: releaseSpy,
    };
    const controller = new AbortController();
    vi.mocked(workerLoop).mockImplementation(async () => {
      controller.abort();
    });
    const scheduler = new WorkerScheduler([WorkerId('w1')], { ...makeBaseDeps(), queue }, 0);
    await scheduler.runUntilComplete(JobId('job-1'), controller.signal);
    expect(releaseSpy).toHaveBeenCalledWith(JobId('job-1'));
  });

  it('marks cancelled when signal aborts while job is running', async () => {
    const markCancelledSpy = vi.fn();
    const queue: JobQueuePort = {
      ...makeQueue({}),
      findById: vi.fn(() => makeJob('job-1', 'running')),
      markCancelled: markCancelledSpy,
    };
    const controller = new AbortController();
    vi.mocked(workerLoop).mockImplementation(async () => {
      controller.abort();
    });
    const scheduler = new WorkerScheduler([WorkerId('w1')], { ...makeBaseDeps(), queue }, 0);
    await scheduler.runUntilComplete(JobId('job-1'), controller.signal);
    expect(markCancelledSpy).toHaveBeenCalledWith(JobId('job-1'), expect.any(Date));
  });

  it('throws within the per-worker timeout window when workerLoop never resolves', async () => {
    const queue = makeQueue({});
    vi.mocked(workerLoop).mockReturnValueOnce(new Promise(() => {}));
    const scheduler = new WorkerScheduler([WorkerId('w1')], { ...makeBaseDeps(), queue }, 50);
    const start = Date.now();
    await expect(
      scheduler.runUntilComplete(JobId('job-1'), new AbortController().signal),
    ).rejects.toThrow(/timed out/);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1_000);
  });
});
