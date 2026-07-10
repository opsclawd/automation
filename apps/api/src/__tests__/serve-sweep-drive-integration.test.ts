import { describe, it, expect, beforeEach } from 'vitest';
import {
  createRun,
  transitionToReady,
  RepositoryId,
  WorkerId,
  createWorker,
} from '@ai-sdlc/domain';
import {
  SweepWaitingRuns,
  WaitingRunsSweeper,
  type SweepWaitingRunsDeps,
  workerLoop,
} from '@ai-sdlc/application';
import {
  FakeRunRepository,
  FakePrReviewRepository,
  FakeGitHubPort,
  FakeEventBus,
  FakeJobQueuePort,
  FakeWorkerLeasePort,
  FakeWorkerRegistryPort,
  FakeRepositoryPort,
} from '@ai-sdlc/application/test-doubles';

function makeWaitingRun(uuid: string, completedAt: Date, prNumber = 7) {
  const run = createRun({
    uuid,
    displayId: `issue-${prNumber}-20260604-000000`,
    repoId: RepositoryId('owner/repo'),
    issueNumber: prNumber,
    startedAt: new Date('2026-06-04T00:00:00Z'),
    type: 'pr_review',
  });
  const running = { ...run, status: 'running' as const };
  const ready = transitionToReady(running);
  return { ...ready, completedAt, repoFullName: 'owner/repo', prNumber };
}

describe('serve sweep-then-drive integration', () => {
  const fixedNow = new Date('2026-06-04T01:00:00Z');
  const serveWorkerId = WorkerId('serve-1');

  let runRepo: FakeRunRepository;
  let prReviewRepo: FakePrReviewRepository;
  let github: FakeGitHubPort;
  let eventBus: FakeEventBus;
  let repos: FakeRepositoryPort;
  let queue: FakeJobQueuePort;
  let registry: FakeWorkerRegistryPort;
  let leases: FakeWorkerLeasePort;

  beforeEach(() => {
    runRepo = new FakeRunRepository();
    prReviewRepo = new FakePrReviewRepository();
    github = new FakeGitHubPort();
    github.prs.set('owner/repo/7', {
      number: 7,
      url: 'https://example/pr/7',
      state: 'open',
      headRefName: 'ai/issue-7',
    });
    github.comments.set('owner/repo/7', [
      {
        id: 1,
        prNumber: 7,
        path: 'a.ts',
        line: 1,
        reviewer: 'octocat',
        body: 'needs work',
        createdAt: new Date('2026-06-04T00:45:00Z'),
      },
    ]);
    eventBus = new FakeEventBus();
    repos = new FakeRepositoryPort([
      {
        id: RepositoryId('owner/repo'),
        fullName: 'owner/repo',
        localBasePath: '/tmp/owner-repo',
        defaultBranch: 'main',
        enabled: true,
      } as never,
    ]);
    queue = new FakeJobQueuePort(repos);
    registry = new FakeWorkerRegistryPort();
    leases = new FakeWorkerLeasePort(registry);
    registry.register(
      createWorker({ id: serveWorkerId, hostname: 'test', processId: 1, now: fixedNow }),
    );
  });

  function makeSweepDeps(): SweepWaitingRunsDeps {
    return {
      runRepository: runRepo,
      prReviewRepo,
      github,
      eventBus,
      now: () => fixedNow,
      readyMaxDays: 7,
      applyReactivation: (run, decision) => {
        if (decision.action === 'timeout') {
          runRepo.update(run.uuid, { status: 'cancelled', completedAt: fixedNow });
        }
      },
      resolvePrContext: async () => ({ repoFullName: 'owner/repo', prNumber: 7 }),
    };
  }

  it('AC1: reactivates a waiting run, enqueues a job, and the drain loop drives it to completion', async () => {
    const run = makeWaitingRun('r1', new Date('2026-06-04T00:30:00Z'));
    runRepo.addRun(run);

    const sweeper = new WaitingRunsSweeper({
      sweep: new SweepWaitingRuns(makeSweepDeps()),
      runRepository: runRepo,
      leases,
      queue,
      eventBus,
      now: () => fixedNow,
      logger: { error: () => {} },
    });
    const sweepResult = await sweeper.execute(serveWorkerId);
    expect(sweepResult.reactivated).toBe(1);
    expect(sweepResult.enqueued).toBe(1);
    expect(runRepo.findByUuid('r1')?.status).toBe('running');

    const executeRun = async () => ({ ok: true });
    await workerLoop(serveWorkerId, {
      registry,
      queue,
      leases,
      repos,
      executeRun,
      prepareWorktree: async () => ({ cwd: '/tmp/wt' }),
      resetWorktree: () => {},
      isWorkerAlive: () => true,
      now: () => fixedNow,
      ttlMs: 60_000,
      findRun: (runId) => runRepo.findByUuid(runId),
      recoverableRunIds: new Set(),
    });

    const jobs = queue.listForRun('r1' as never);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe('succeeded');
  });

  it('AC2: a run already leased by another worker is not double-driven by the sweep-then-drain path', async () => {
    const run = makeWaitingRun('r2', new Date('2026-06-04T00:30:00Z'));
    runRepo.addRun(run);
    leases.acquire({
      repoId: RepositoryId('owner/repo'),
      workerId: WorkerId('cli-other'),
      runId: 'r2' as never,
      now: fixedNow,
      ttlMs: 60_000,
    });

    const sweeper = new WaitingRunsSweeper({
      sweep: new SweepWaitingRuns(makeSweepDeps()),
      runRepository: runRepo,
      leases,
      queue,
      eventBus,
      now: () => fixedNow,
      logger: { error: () => {} },
    });
    const sweepResult = await sweeper.execute(serveWorkerId);
    expect(sweepResult.reactivated).toBe(1);
    expect(sweepResult.enqueued).toBe(0);
    expect(sweepResult.skippedLeaseConflict).toBe(1);

    const executeRun = async () => ({ ok: true });
    await workerLoop(serveWorkerId, {
      registry,
      queue,
      leases,
      repos,
      executeRun,
      prepareWorktree: async () => ({ cwd: '/tmp/wt' }),
      resetWorktree: () => {},
      isWorkerAlive: () => true,
      now: () => fixedNow,
      ttlMs: 60_000,
      findRun: (runId) => runRepo.findByUuid(runId),
      recoverableRunIds: new Set(),
    });

    const jobs = queue.listForRun('r2' as never);
    expect(jobs).toHaveLength(0);
  });
});
