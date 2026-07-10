import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createRun,
  transitionToReady,
  RepositoryId,
  WorkerId,
  WorkerLeaseConflictError,
} from '@ai-sdlc/domain';
import { SweepWaitingRuns, type SweepWaitingRunsDeps } from '../sweep-waiting-runs.js';
import { WaitingRunsSweeper } from '../waiting-runs-sweeper.js';
import { FakeRunRepository } from '../test-doubles/fake-run-repository.js';
import { FakePrReviewRepository } from '../test-doubles/fake-pr-review-repository.js';
import { FakeGitHubPort } from '../test-doubles/fake-github-port.js';
import { FakeEventBus } from '../test-doubles/fake-event-bus.js';
import { FakeJobQueuePort } from '../test-doubles/fake-job-queue-port.js';
import { FakeRepositoryPort } from '../test-doubles/fake-repository-port.js';
import { FakeWorkerLeasePort } from '../test-doubles/fake-worker-lease-port.js';
import { FakeWorkerRegistryPort } from '../test-doubles/fake-worker-registry-port.js';

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

const fixedNow = new Date('2026-06-04T01:00:00Z');
const workerId = WorkerId('serve-1');

describe('WaitingRunsSweeper', () => {
  let runRepo: FakeRunRepository;
  let prReviewRepo: FakePrReviewRepository;
  let github: FakeGitHubPort;
  let eventBus: FakeEventBus;
  let queue: FakeJobQueuePort;
  let leases: FakeWorkerLeasePort;
  let registry: FakeWorkerRegistryPort;
  let repos: FakeRepositoryPort;
  let sweepDeps: SweepWaitingRunsDeps;

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
    sweepDeps = {
      runRepository: runRepo,
      prReviewRepo,
      github,
      eventBus,
      now: () => fixedNow,
      readyMaxDays: 7,
      applyReactivation: (run, decision) => {
        // Defer DB updates for reactivate; handle timeout immediately.
        if (decision.action === 'timeout') {
          runRepo.update(run.uuid, { status: 'cancelled', completedAt: fixedNow });
        }
      },
      resolvePrContext: async () => ({ repoFullName: 'owner/repo', prNumber: 7 }),
    };
  });

  it('enqueues a job for a reactivated run and transitions it to running after acquiring a lease', async () => {
    const run = makeWaitingRun('w1', new Date('2026-06-04T00:30:00Z'));
    runRepo.addRun(run);
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
    const sweeper = new WaitingRunsSweeper({
      sweep: new SweepWaitingRuns(sweepDeps),
      runRepository: runRepo,
      leases,
      queue,
      eventBus,
      now: () => fixedNow,
      logger: { error: () => {} },
    });
    const result = await sweeper.execute(workerId);
    expect(result.reactivated).toBe(1);
    expect(result.enqueued).toBe(1);
    expect(result.skippedLeaseConflict).toBe(0);
    expect(result.enqueueErrors).toEqual([]);
    const jobs = queue.listForRun('w1' as never);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe('queued');
    expect(runRepo.findByUuid('w1')?.status).toBe('running');
  });

  it('skips enqueuing gracefully if a lease conflict occurs', async () => {
    const run = makeWaitingRun('w1', new Date('2026-06-04T00:30:00Z'));
    runRepo.addRun(run);
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
    vi.spyOn(leases, 'acquire').mockImplementationOnce(() => {
      throw new WorkerLeaseConflictError('owner/repo', WorkerId('other-worker'));
    });
    const sweeper = new WaitingRunsSweeper({
      sweep: new SweepWaitingRuns(sweepDeps),
      runRepository: runRepo,
      leases,
      queue,
      eventBus,
      now: () => fixedNow,
      logger: { error: () => {} },
    });
    const result = await sweeper.execute(workerId);
    expect(result.reactivated).toBe(1);
    expect(result.enqueued).toBe(0);
    expect(result.skippedLeaseConflict).toBe(1);
    expect(result.enqueueErrors).toEqual([]);
    expect(runRepo.findByUuid('w1')?.status).toBe('waiting');
  });

  it('does not enqueue a job when a run stays ready', async () => {
    const run = makeWaitingRun('w2', new Date('2026-06-04T00:00:00Z'));
    runRepo.addRun(run);
    github.comments.set('owner/repo/7', []);
    const sweeper = new WaitingRunsSweeper({
      sweep: new SweepWaitingRuns(sweepDeps),
      runRepository: runRepo,
      leases,
      queue,
      eventBus,
      now: () => fixedNow,
      logger: { error: () => {} },
    });
    const result = await sweeper.execute(workerId);
    expect(result.stayedReady).toBe(1);
    expect(result.enqueued).toBe(0);
    expect(queue.listForRun('w2' as never)).toHaveLength(0);
    expect(runRepo.findByUuid('w2')?.status).toBe('waiting');
  });

  it('rolls back the run status to waiting and records an enqueue error when enqueue fails', async () => {
    const run = makeWaitingRun('w3', new Date('2026-06-04T00:30:00Z'));
    runRepo.addRun(run);
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
    vi.spyOn(queue, 'enqueue').mockImplementationOnce(() => {
      throw new Error('Enqueue failed');
    });
    const sweeper = new WaitingRunsSweeper({
      sweep: new SweepWaitingRuns(sweepDeps),
      runRepository: runRepo,
      leases,
      queue,
      eventBus,
      now: () => fixedNow,
      logger: { error: () => {} },
    });
    const result = await sweeper.execute(workerId);
    expect(result.reactivated).toBe(1);
    expect(result.enqueued).toBe(0);
    expect(result.enqueueErrors).toHaveLength(1);
    expect(result.enqueueErrors[0]?.error).toBe('Enqueue failed');
    expect(runRepo.findByUuid('w3')?.status).toBe('waiting');
  });
});
