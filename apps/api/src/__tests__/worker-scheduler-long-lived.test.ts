import { describe, expect, it, vi, beforeEach } from 'vitest';
import { WorkerScheduler } from '../worker-scheduler.js';
import { workerLoop } from '@ai-sdlc/application';
import { WorkerId, JobId, RunId, RepositoryId, IssueNumber } from '@ai-sdlc/domain';
import type { JobQueuePort, RepositoryPort } from '@ai-sdlc/application/ports';

vi.mock('@ai-sdlc/application', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ai-sdlc/application')>();
  return { ...actual, workerLoop: vi.fn().mockResolvedValue(undefined) };
});

function makeJob(
  id: string,
  repoId: string,
  status: string,
): ReturnType<JobQueuePort['findById']> {
  return {
    id: JobId(id),
    status,
    runId: RunId(`run-${id}`),
    repoId: RepositoryId(repoId),
    issueNumber: IssueNumber(1),
    priority: 0,
    attempts: 0,
    createdAt: new Date(),
  } as unknown as ReturnType<JobQueuePort['findById']>;
}

describe('WorkerScheduler (long-lived)', () => {
  beforeEach(() => {
    vi.mocked(workerLoop).mockClear();
  });

  it('cycles through enabled repositories and claims jobs for them', async () => {
    const repo1 = { id: RepositoryId('org/repo1'), fullName: 'org/repo1', enabled: true, maxConcurrentRuns: 1 };
    const repo2 = { id: RepositoryId('org/repo2'), fullName: 'org/repo2', enabled: true, maxConcurrentRuns: 1 };

    const repos: RepositoryPort = {
      listEnabled: vi.fn(() => [repo1, repo2]),
      findById: vi.fn((id) => [repo1, repo2].find(r => r.id === id)),
      findByFullName: vi.fn(),
    } as any;

    const queue: JobQueuePort = {
      reclaimStaleClaims: vi.fn(),
      listForRepo: vi.fn(() => []),
      listActive: vi.fn(() => []),
      listForRun: vi.fn(() => []),
      findById: vi.fn(),
      claimNext: vi.fn(),
      releaseClaim: vi.fn(),
      resetToQueued: vi.fn(),
      markRunning: vi.fn(),
      markSucceeded: vi.fn(),
      markFailed: vi.fn(),
      markCancelled: vi.fn(),
      findExpiredClaims: vi.fn(() => []),
      enqueue: vi.fn(),
    };

    const registry = {
      findById: vi.fn(() => ({ status: 'idle' })),
    } as any;

    const baseDeps = { queue, repos, registry, now: () => new Date() } as any;
    const scheduler = new WorkerScheduler([WorkerId('w1'), WorkerId('w2')], baseDeps, 1);

    const controller = new AbortController();

    vi.mocked(workerLoop).mockImplementation(async () => {
        controller.abort();
    });

    await scheduler.start(controller.signal);

    expect(repos.listEnabled).toHaveBeenCalled();
    // Round robin should have tried to claim from both repos in one tick because we have 2 workers
    expect(workerLoop).toHaveBeenCalledWith(WorkerId('w1'), expect.objectContaining({ repoId: 'org/repo1' }));
    expect(workerLoop).toHaveBeenCalledWith(WorkerId('w2'), expect.objectContaining({ repoId: 'org/repo2' }));
  });

  it('respects per-repository concurrency limits', async () => {
      const repo1 = { id: RepositoryId('org/repo1'), fullName: 'org/repo1', enabled: true, maxConcurrentRuns: 1 };

      const repos: RepositoryPort = {
        listEnabled: vi.fn(() => [repo1]),
        findById: vi.fn((id) => id === 'org/repo1' ? repo1 : undefined),
        findByFullName: vi.fn(),
      } as any;

      const queue: JobQueuePort = {
        reclaimStaleClaims: vi.fn(),
        listActive: vi.fn(() => []),
        listForRepo: vi.fn(() => [makeJob('j1', 'org/repo1', 'running')]), // Already one running
        listForRun: vi.fn(() => []),
        findById: vi.fn(),
        claimNext: vi.fn(),
        releaseClaim: vi.fn(),
        resetToQueued: vi.fn(),
        markRunning: vi.fn(),
        markSucceeded: vi.fn(),
        markFailed: vi.fn(),
        markCancelled: vi.fn(),
        findExpiredClaims: vi.fn(() => []),
        enqueue: vi.fn(),
      };

      const registry = {
        findById: vi.fn(() => ({ status: 'idle' })),
      } as any;

      const baseDeps = { queue, repos, registry, now: () => new Date() } as any;
      const scheduler = new WorkerScheduler([WorkerId('w1')], baseDeps, 1);

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100);

      await scheduler.start(controller.signal);

      // Should NOT have called workerLoop because repo is at its limit
      expect(workerLoop).not.toHaveBeenCalled();
  });
});
