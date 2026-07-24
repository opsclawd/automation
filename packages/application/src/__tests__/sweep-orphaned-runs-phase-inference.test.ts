import { describe, expect, it } from 'vitest';
import { SweepOrphanedRuns } from '../sweep-orphaned-runs.js';
import { FakeRunRepository } from '../test-doubles/fake-run-repository.js';
import { FakePhaseRepository } from '../test-doubles/fake-phase-repository.js';

const fixedNow = () => new Date('2026-05-13T19:23:00Z');

describe('SweepOrphanedRuns phase inference', () => {
  it('reconciles a dead run to needs_human_review from its latest phase', () => {
    const repo = new FakeRunRepository();
    const phaseRepo = new FakePhaseRepository();
    repo.addRun({
      uuid: 'orphan-1',
      displayId: 'issue-1-20260513-000000',
      issueNumber: 1,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T18:00:00Z'),
      pid: 99999,
    });
    phaseRepo.insert({
      id: 'phase-1',
      runUuid: 'orphan-1',
      name: 'implement',
      status: 'needs_human_review',
      attempt: 1,
      startedAt: new Date('2026-05-13T18:30:00Z'),
      completedAt: new Date('2026-05-13T18:45:00Z'),
    });

    const reconciler = new SweepOrphanedRuns({
      runRepository: repo,
      phaseRepository: phaseRepo,
      isProcessAlive: (pid: number) => pid !== 99999,
      now: fixedNow,
    });

    const entry = reconciler.reconcile(repo.findByUuid('orphan-1')!);
    expect(entry?.run.status).toBe('needs_human_review');
    expect(repo.findByUuid('orphan-1')).toMatchObject({
      status: 'needs_human_review',
      completedAt: fixedNow(),
      failureReason: 'orphaned: process 99999 no longer running',
    });
  });

  it('reconciles a dead run to blocked from its latest phase', () => {
    const repo = new FakeRunRepository();
    const phaseRepo = new FakePhaseRepository();
    repo.addRun({
      uuid: 'orphan-2',
      displayId: 'issue-2-20260513-000000',
      issueNumber: 2,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T18:00:00Z'),
      pid: 99999,
    });
    phaseRepo.insert({
      id: 'phase-1',
      runUuid: 'orphan-2',
      name: 'implement',
      status: 'blocked',
      attempt: 1,
      startedAt: new Date('2026-05-13T18:30:00Z'),
      completedAt: new Date('2026-05-13T18:45:00Z'),
    });

    const reconciler = new SweepOrphanedRuns({
      runRepository: repo,
      phaseRepository: phaseRepo,
      isProcessAlive: (pid: number) => pid !== 99999,
      now: fixedNow,
    });

    const entry = reconciler.reconcile(repo.findByUuid('orphan-2')!);
    expect(entry?.run.status).toBe('blocked');
    expect(repo.findByUuid('orphan-2')).toMatchObject({
      status: 'blocked',
      completedAt: fixedNow(),
      failureReason: 'orphaned: process 99999 no longer running',
    });
  });

  it('falls back to failed when the latest phase is not blocked or needs_human_review', () => {
    const repo = new FakeRunRepository();
    const phaseRepo = new FakePhaseRepository();
    repo.addRun({
      uuid: 'orphan-3',
      displayId: 'issue-3-20260513-000000',
      issueNumber: 3,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T18:00:00Z'),
      pid: 99999,
    });
    phaseRepo.insert({
      id: 'phase-1',
      runUuid: 'orphan-3',
      name: 'implement',
      status: 'passed',
      attempt: 1,
      startedAt: new Date('2026-05-13T18:30:00Z'),
      completedAt: new Date('2026-05-13T18:45:00Z'),
    });

    const reconciler = new SweepOrphanedRuns({
      runRepository: repo,
      phaseRepository: phaseRepo,
      isProcessAlive: (pid: number) => pid !== 99999,
      now: fixedNow,
    });

    const entry = reconciler.reconcile(repo.findByUuid('orphan-3')!);
    expect(entry?.run.status).toBe('failed');
    expect(repo.findByUuid('orphan-3')).toMatchObject({
      status: 'failed',
      completedAt: fixedNow(),
      failureReason: 'orphaned: process 99999 no longer running',
    });
  });

  it('uses the newest phase rather than an older recoverable phase', () => {
    const repo = new FakeRunRepository();
    const phaseRepo = new FakePhaseRepository();
    repo.addRun({
      uuid: 'orphan-4',
      displayId: 'issue-4-20260513-000000',
      issueNumber: 4,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T18:00:00Z'),
      pid: 99999,
    });
    phaseRepo.insert({
      id: 'phase-old',
      runUuid: 'orphan-4',
      name: 'implement',
      status: 'blocked',
      attempt: 1,
      startedAt: new Date('2026-05-13T18:30:00Z'),
      completedAt: new Date('2026-05-13T18:45:00Z'),
    });
    phaseRepo.insert({
      id: 'phase-new',
      runUuid: 'orphan-4',
      name: 'review',
      status: 'passed',
      attempt: 1,
      startedAt: new Date('2026-05-13T18:50:00Z'),
      completedAt: new Date('2026-05-13T19:00:00Z'),
    });

    const reconciler = new SweepOrphanedRuns({
      runRepository: repo,
      phaseRepository: phaseRepo,
      isProcessAlive: (pid: number) => pid !== 99999,
      now: fixedNow,
    });

    const entry = reconciler.reconcile(repo.findByUuid('orphan-4')!);
    expect(entry?.run.status).toBe('failed');
  });

  it('does not reconcile an alive pid-less or concurrently changed run', () => {
    const repo = new FakeRunRepository();
    const phaseRepo = new FakePhaseRepository();

    repo.addRun({
      uuid: 'alive-1',
      displayId: 'issue-5-20260513-000000',
      issueNumber: 5,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T18:00:00Z'),
      pid: 1234,
    });

    repo.addRun({
      uuid: 'pidless-1',
      displayId: 'issue-6-20260513-000000',
      issueNumber: 6,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T18:00:00Z'),
    });

    const reconciler = new SweepOrphanedRuns({
      runRepository: repo,
      phaseRepository: phaseRepo,
      isProcessAlive: () => true,
      now: fixedNow,
    });

    const aliveEntry = reconciler.reconcile(repo.findByUuid('alive-1')!);
    expect(aliveEntry).toBeUndefined();
    expect(repo.findByUuid('alive-1')).toMatchObject({ status: 'running' });

    const pidlessEntry = reconciler.reconcile(repo.findByUuid('pidless-1')!);
    expect(pidlessEntry).toBeUndefined();
    expect(repo.findByUuid('pidless-1')).toMatchObject({ status: 'running' });
  });

  it('returns undefined without overwriting when compare-and-set fails', () => {
    const repo = new FakeRunRepository();
    const phaseRepo = new FakePhaseRepository();
    repo.addRun({
      uuid: 'orphan-lost',
      displayId: 'issue-7-20260513-000000',
      issueNumber: 7,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T18:00:00Z'),
      pid: 99999,
    });
    phaseRepo.insert({
      id: 'phase-1',
      runUuid: 'orphan-lost',
      name: 'implement',
      status: 'needs_human_review',
      attempt: 1,
      startedAt: new Date('2026-05-13T18:30:00Z'),
      completedAt: new Date('2026-05-13T18:45:00Z'),
    });

    const fakeRepo = new FakeRunRepository();
    fakeRepo.addRun({
      uuid: 'orphan-lost',
      displayId: 'issue-7-20260513-000000',
      issueNumber: 7,
      type: 'issue_to_pr',
      status: 'failed',
      completedPhases: [],
      startedAt: new Date('2026-05-13T18:00:00Z'),
      pid: 99999,
    });

    const reconciler = new SweepOrphanedRuns({
      runRepository: fakeRepo,
      phaseRepository: phaseRepo,
      isProcessAlive: (pid: number) => pid !== 99999,
      now: fixedNow,
    });

    const entry = reconciler.reconcile(repo.findByUuid('orphan-lost')!);
    expect(entry).toBeUndefined();
    expect(fakeRepo.findByUuid('orphan-lost')).toMatchObject({ status: 'failed' });
  });

  it('enqueues from the phase-inferred status', async () => {
    const { OrphanedRunsSweeper } = await import('../orphaned-runs-sweeper.js');
    const { createRun, RepositoryId } = await import('@ai-sdlc/domain');
    const { FakeJobQueuePort } = await import('../test-doubles/fake-job-queue-port.js');
    const { FakeWorkerLeasePort } = await import('../test-doubles/fake-worker-lease-port.js');
    const { FakeWorkerRegistryPort } = await import('../test-doubles/fake-worker-registry-port.js');
    const { FakeRepositoryPort } = await import('../test-doubles/fake-repository-port.js');
    const { FakeEventBus } = await import('../test-doubles/fake-event-bus.js');

    const fixed = fixedNow();
    const repoId = RepositoryId('owner/repo');

    const failed = createRun({
      uuid: 'o-hr',
      displayId: 'issue-hr-20260710-000000',
      repoId,
      issueNumber: 1,
      startedAt: new Date('2026-07-09T00:00:00Z'),
    });
    const { failRun } = await import('@ai-sdlc/domain');
    const failedRun = failRun(
      { ...failed, completedPhases: [] },
      'orphaned: process 99999 no longer running',
      fixed,
    );

    const repo = new FakeRunRepository();
    repo.addRun(failedRun);

    const queue = new FakeJobQueuePort(
      new FakeRepositoryPort([
        {
          id: repoId,
          fullName: 'owner/repo',
          localBasePath: '/tmp/owner-repo',
          defaultBranch: 'main',
          enabled: true,
        } as never,
      ]),
    );
    const leases = new FakeWorkerLeasePort(new FakeWorkerRegistryPort());
    const eventBus = new FakeEventBus();

    const sweeper = new OrphanedRunsSweeper({
      runRepository: repo,
      leases,
      queue,
      eventBus,
      now: () => fixed,
      logger: { error: () => {} },
    });

    const result = await sweeper.execute([
      { uuid: 'o-hr', run: failedRun, previousPid: 99999, previousStatus: 'running' },
    ]);

    expect(result.enqueued).toBe(1);
    expect(repo.findByUuid('o-hr')?.status).toBe('running');
    expect(leases.current(repoId)).toBeUndefined();
  });

  it('restores the inferred status after an enqueue failure', async () => {
    const { OrphanedRunsSweeper } = await import('../orphaned-runs-sweeper.js');
    const { createRun, RepositoryId } = await import('@ai-sdlc/domain');
    const { failRun } = await import('@ai-sdlc/domain');
    const { FakeJobQueuePort } = await import('../test-doubles/fake-job-queue-port.js');
    const { FakeWorkerLeasePort } = await import('../test-doubles/fake-worker-lease-port.js');
    const { FakeWorkerRegistryPort } = await import('../test-doubles/fake-worker-registry-port.js');
    const { FakeRepositoryPort } = await import('../test-doubles/fake-repository-port.js');
    const { FakeEventBus } = await import('../test-doubles/fake-event-bus.js');
    const { vi } = await import('vitest');

    const fixed = fixedNow();
    const repoId = RepositoryId('owner/repo');

    const failed = createRun({
      uuid: 'o-blocked',
      displayId: 'issue-blocked-20260710-000000',
      repoId,
      issueNumber: 1,
      startedAt: new Date('2026-07-09T00:00:00Z'),
    });
    const failedRun = failRun(
      { ...failed, completedPhases: [] },
      'orphaned: process 99999 no longer running',
      fixed,
    );

    const repo = new FakeRunRepository();
    repo.addRun(failedRun);

    const queue = new FakeJobQueuePort(
      new FakeRepositoryPort([
        {
          id: repoId,
          fullName: 'owner/repo',
          localBasePath: '/tmp/owner-repo',
          defaultBranch: 'main',
          enabled: true,
        } as never,
      ]),
    );
    const leases = new FakeWorkerLeasePort(new FakeWorkerRegistryPort());
    const eventBus = new FakeEventBus();

    vi.spyOn(queue, 'enqueue').mockImplementationOnce(() => {
      throw new Error('enqueue DB write failed');
    });

    const sweeper = new OrphanedRunsSweeper({
      runRepository: repo,
      leases,
      queue,
      eventBus,
      now: () => fixed,
      logger: { error: () => {} },
    });

    const result = await sweeper.execute([
      { uuid: 'o-blocked', run: failedRun, previousPid: 99999, previousStatus: 'running' },
    ]);

    expect(result.enqueued).toBe(0);
    expect(result.enqueueErrors).toHaveLength(1);
    const after = repo.findByUuid('o-blocked');
    expect(after?.status).toBe('running');
  });

  it('skips enqueueing and leaves the run blocked for the blocked inferred status', async () => {
    const { OrphanedRunsSweeper } = await import('../orphaned-runs-sweeper.js');
    const { createRun, RepositoryId } = await import('@ai-sdlc/domain');
    const { blockRun } = await import('@ai-sdlc/domain');
    const { FakeJobQueuePort } = await import('../test-doubles/fake-job-queue-port.js');
    const { FakeWorkerLeasePort } = await import('../test-doubles/fake-worker-lease-port.js');
    const { FakeWorkerRegistryPort } = await import('../test-doubles/fake-worker-registry-port.js');
    const { FakeRepositoryPort } = await import('../test-doubles/fake-repository-port.js');
    const { FakeEventBus } = await import('../test-doubles/fake-event-bus.js');

    const fixed = fixedNow();
    const repoId = RepositoryId('owner/repo');

    const created = createRun({
      uuid: 'o-blocked',
      displayId: 'issue-blocked-20260710-000000',
      repoId,
      issueNumber: 1,
      startedAt: new Date('2026-07-09T00:00:00Z'),
    });
    const blockedRun = blockRun(
      { ...created, completedPhases: [] },
      'orphaned: process 99999 no longer running',
      fixed,
    );

    const repo = new FakeRunRepository();
    repo.addRun(blockedRun);

    const queue = new FakeJobQueuePort(
      new FakeRepositoryPort([
        {
          id: repoId,
          fullName: 'owner/repo',
          localBasePath: '/tmp/owner-repo',
          defaultBranch: 'main',
          enabled: true,
        } as never,
      ]),
    );
    const leases = new FakeWorkerLeasePort(new FakeWorkerRegistryPort());
    const eventBus = new FakeEventBus();

    const sweeper = new OrphanedRunsSweeper({
      runRepository: repo,
      leases,
      queue,
      eventBus,
      now: () => fixed,
      logger: { error: () => {} },
    });

    const result = await sweeper.execute([
      { uuid: 'o-blocked', run: blockedRun, previousPid: 99999, previousStatus: 'running' },
    ]);

    expect(result.enqueued).toBe(0);
    expect(repo.findByUuid('o-blocked')?.status).toBe('blocked');
    expect(leases.current(repoId)).toBeUndefined();
  });

  it('leaves the blocked status untouched without attempting to enqueue', async () => {
    const { OrphanedRunsSweeper } = await import('../orphaned-runs-sweeper.js');
    const { createRun, RepositoryId } = await import('@ai-sdlc/domain');
    const { blockRun } = await import('@ai-sdlc/domain');
    const { FakeJobQueuePort } = await import('../test-doubles/fake-job-queue-port.js');
    const { FakeWorkerLeasePort } = await import('../test-doubles/fake-worker-lease-port.js');
    const { FakeWorkerRegistryPort } = await import('../test-doubles/fake-worker-registry-port.js');
    const { FakeRepositoryPort } = await import('../test-doubles/fake-repository-port.js');
    const { FakeEventBus } = await import('../test-doubles/fake-event-bus.js');
    const { vi } = await import('vitest');

    const fixed = fixedNow();
    const repoId = RepositoryId('owner/repo');

    const created = createRun({
      uuid: 'o-blocked-restore',
      displayId: 'issue-blocked-restore-20260710-000000',
      repoId,
      issueNumber: 1,
      startedAt: new Date('2026-07-09T00:00:00Z'),
    });
    const blockedRun = blockRun(
      { ...created, completedPhases: [] },
      'orphaned: process 99999 no longer running',
      fixed,
    );

    const repo = new FakeRunRepository();
    repo.addRun(blockedRun);

    const queue = new FakeJobQueuePort(
      new FakeRepositoryPort([
        {
          id: repoId,
          fullName: 'owner/repo',
          localBasePath: '/tmp/owner-repo',
          defaultBranch: 'main',
          enabled: true,
        } as never,
      ]),
    );
    const leases = new FakeWorkerLeasePort(new FakeWorkerRegistryPort());
    const eventBus = new FakeEventBus();

    const enqueueSpy = vi.spyOn(queue, 'enqueue');

    const sweeper = new OrphanedRunsSweeper({
      runRepository: repo,
      leases,
      queue,
      eventBus,
      now: () => fixed,
      logger: { error: () => {} },
    });

    const result = await sweeper.execute([
      { uuid: 'o-blocked-restore', run: blockedRun, previousPid: 99999, previousStatus: 'running' },
    ]);

    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(result.enqueued).toBe(0);
    expect(result.enqueueErrors).toHaveLength(0);
    const after = repo.findByUuid('o-blocked-restore');
    expect(after?.status).toBe('blocked');
  });

  it('skips enqueueing and leaves the run needs_human_review for the needs_human_review inferred status', async () => {
    const { OrphanedRunsSweeper } = await import('../orphaned-runs-sweeper.js');
    const { createRun, RepositoryId } = await import('@ai-sdlc/domain');
    const { markRunNeedsHumanReview } = await import('@ai-sdlc/domain');
    const { FakeJobQueuePort } = await import('../test-doubles/fake-job-queue-port.js');
    const { FakeWorkerLeasePort } = await import('../test-doubles/fake-worker-lease-port.js');
    const { FakeWorkerRegistryPort } = await import('../test-doubles/fake-worker-registry-port.js');
    const { FakeRepositoryPort } = await import('../test-doubles/fake-repository-port.js');
    const { FakeEventBus } = await import('../test-doubles/fake-event-bus.js');

    const fixed = fixedNow();
    const repoId = RepositoryId('owner/repo');

    const created = createRun({
      uuid: 'o-nhr',
      displayId: 'issue-nhr-20260710-000000',
      repoId,
      issueNumber: 1,
      startedAt: new Date('2026-07-09T00:00:00Z'),
    });
    const nhrRun = markRunNeedsHumanReview(
      { ...created, completedPhases: [] },
      'orphaned: process 99999 no longer running',
      fixed,
    );

    const repo = new FakeRunRepository();
    repo.addRun(nhrRun);

    const queue = new FakeJobQueuePort(
      new FakeRepositoryPort([
        {
          id: repoId,
          fullName: 'owner/repo',
          localBasePath: '/tmp/owner-repo',
          defaultBranch: 'main',
          enabled: true,
        } as never,
      ]),
    );
    const leases = new FakeWorkerLeasePort(new FakeWorkerRegistryPort());
    const eventBus = new FakeEventBus();

    const sweeper = new OrphanedRunsSweeper({
      runRepository: repo,
      leases,
      queue,
      eventBus,
      now: () => fixed,
      logger: { error: () => {} },
    });

    const result = await sweeper.execute([
      { uuid: 'o-nhr', run: nhrRun, previousPid: 99999, previousStatus: 'running' },
    ]);

    expect(result.enqueued).toBe(0);
    expect(repo.findByUuid('o-nhr')?.status).toBe('needs_human_review');
    expect(leases.current(repoId)).toBeUndefined();
  });

  it('leaves the needs_human_review status untouched without attempting to enqueue', async () => {
    const { OrphanedRunsSweeper } = await import('../orphaned-runs-sweeper.js');
    const { createRun, RepositoryId } = await import('@ai-sdlc/domain');
    const { markRunNeedsHumanReview } = await import('@ai-sdlc/domain');
    const { FakeJobQueuePort } = await import('../test-doubles/fake-job-queue-port.js');
    const { FakeWorkerLeasePort } = await import('../test-doubles/fake-worker-lease-port.js');
    const { FakeWorkerRegistryPort } = await import('../test-doubles/fake-worker-registry-port.js');
    const { FakeRepositoryPort } = await import('../test-doubles/fake-repository-port.js');
    const { FakeEventBus } = await import('../test-doubles/fake-event-bus.js');
    const { vi } = await import('vitest');

    const fixed = fixedNow();
    const repoId = RepositoryId('owner/repo');

    const created = createRun({
      uuid: 'o-nhr-restore',
      displayId: 'issue-nhr-restore-20260710-000000',
      repoId,
      issueNumber: 1,
      startedAt: new Date('2026-07-09T00:00:00Z'),
    });
    const nhrRun = markRunNeedsHumanReview(
      { ...created, completedPhases: [] },
      'orphaned: process 99999 no longer running',
      fixed,
    );

    const repo = new FakeRunRepository();
    repo.addRun(nhrRun);

    const queue = new FakeJobQueuePort(
      new FakeRepositoryPort([
        {
          id: repoId,
          fullName: 'owner/repo',
          localBasePath: '/tmp/owner-repo',
          defaultBranch: 'main',
          enabled: true,
        } as never,
      ]),
    );
    const leases = new FakeWorkerLeasePort(new FakeWorkerRegistryPort());
    const eventBus = new FakeEventBus();

    const enqueueSpy = vi.spyOn(queue, 'enqueue');

    const sweeper = new OrphanedRunsSweeper({
      runRepository: repo,
      leases,
      queue,
      eventBus,
      now: () => fixed,
      logger: { error: () => {} },
    });

    const result = await sweeper.execute([
      { uuid: 'o-nhr-restore', run: nhrRun, previousPid: 99999, previousStatus: 'running' },
    ]);

    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(result.enqueued).toBe(0);
    expect(result.enqueueErrors).toHaveLength(0);
    const after = repo.findByUuid('o-nhr-restore');
    expect(after?.status).toBe('needs_human_review');
  });
});
