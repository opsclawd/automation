import { describe, it, expect, beforeEach } from 'vitest';
import {
  RepositoryId,
  ReleaseBatchId,
  createReleaseBatch,
  admitItem,
  type Repository,
} from '@ai-sdlc/domain';
import { ReleaseBatchCoordinator } from '../release-batch-coordinator.js';
import { FakeReleaseBatchRepository } from '../test-doubles/fake-release-batch-repository.js';
import { FakeRunRepository } from '../test-doubles/fake-run-repository.js';
import { FakeJobQueuePort } from '../test-doubles/fake-job-queue-port.js';
import { FakeEventBus } from '../test-doubles/fake-event-bus.js';
import { FakeRepositoryPort } from '../test-doubles/fake-repository-port.js';
import { FakeGitHubPort } from '../test-doubles/fake-github-port.js';
import { FakeGitPort } from '../test-doubles/fake-git-port.js';
import { FakeEnvironmentHealthPort } from '../test-doubles/fake-environment-health-port.js';
import { InterItemMaintenanceService } from '../inter-item-maintenance.js';
import { ReapOrphanedTestWorkers } from '../reap-orphaned-test-workers.js';

function createTestRepo(overrides?: Partial<Repository>): Repository {
  return {
    id: RepositoryId('test-org/test-repo'),
    owner: 'test-org',
    name: 'test-repo',
    fullName: 'test-org/test-repo',
    defaultBranch: 'main',
    remoteUrl: 'https://github.com/test-org/test-repo.git',
    localBasePath: '/tmp/test-repo',
    enabled: true,
    maxConcurrentRuns: 1,
    healthStatus: 'healthy',
    healthError: null,
    lastHealthCheckAt: new Date(),
    configMetadata: '{}',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('ReleaseBatchCoordinator', () => {
  let releaseBatchRepository: FakeReleaseBatchRepository;
  let runRepository: FakeRunRepository;
  let repositoryPort: FakeRepositoryPort;
  let jobQueue: FakeJobQueuePort;
  let eventBus: FakeEventBus;
  let coordinator: ReleaseBatchCoordinator;
  let defaultRepo: Repository;

  const t0 = new Date('2026-09-11T12:00:00.000Z');
  const t1 = new Date('2026-09-11T12:05:00.000Z');
  const t2 = new Date('2026-09-11T12:10:00.000Z');

  beforeEach(() => {
    defaultRepo = createTestRepo();
    repositoryPort = new FakeRepositoryPort([defaultRepo]);
    releaseBatchRepository = new FakeReleaseBatchRepository();
    runRepository = new FakeRunRepository();
    jobQueue = new FakeJobQueuePort(repositoryPort);
    eventBus = new FakeEventBus();

    coordinator = new ReleaseBatchCoordinator({
      releaseBatchRepository,
      runRepository,
      jobQueue,
      repositoryPort,
      eventBus,
      now: () => t1,
    });
  });

  function setupFiveItemBatch(initialItemAdmitted = true) {
    const batchId = ReleaseBatchId('batch-five-items');
    let batch = createReleaseBatch({
      id: batchId,
      repoId: defaultRepo.id,
      sourceBranch: 'main',
      sourceStartSha: 'sha-root-000',
      releaseBranch: 'release/2026-09-11-batch-five',
      createdAt: t0,
      items: [
        { position: 1, issueNumber: 101 },
        { position: 2, issueNumber: 102 },
        { position: 3, issueNumber: 103 },
        { position: 4, issueNumber: 104 },
        { position: 5, issueNumber: 105 },
      ],
    });

    if (initialItemAdmitted) {
      batch = admitItem(batch, 1, {
        runUuid: 'run-item-1',
        baseSha: 'sha-root-000',
        now: t0,
      });
      runRepository.insertIfNoActive({
        uuid: 'run-item-1',
        displayId: 'issue-101-001',
        repoId: defaultRepo.id,
        issueNumber: 101,
        startedAt: t0,
        type: 'issue_to_pr',
        baseBranch: batch.releaseBranch,
        status: 'running',
        completedPhases: [],
        skippedPhases: [],
      });
      coordinator['ensureJobEnqueued'](defaultRepo.id, 'run-item-1', 101, t0);
    }

    releaseBatchRepository.insert(batch);
    return { batchId, batch };
  }

  describe('Core rule: lazy admission', () => {
    it('ensures a 5-item ReleaseBatch has exactly one admitted Run and pending items have no Run UUID', async () => {
      const { batchId } = setupFiveItemBatch();

      const result = await coordinator.reconcile(batchId);
      expect(result.batchStatus).toBe('building');

      const saved = releaseBatchRepository.findById(batchId)!;
      // Item 1 is active with Run UUID
      expect(saved.items[0]?.status).toBe('active');
      expect(saved.items[0]?.runUuid).toBe('run-item-1');

      // Items 2..5 remain pending with no Run UUID
      for (let i = 1; i < 5; i++) {
        expect(saved.items[i]?.status).toBe('pending');
        expect(saved.items[i]?.runUuid).toBeUndefined();
      }

      // Exactly one Run in runRepository and one Job in jobQueue
      expect(runRepository.runs.size).toBe(1);
      expect(jobQueue.listActive()).toHaveLength(1);
    });
  });

  describe('Blocker synchronization', () => {
    it('blocks batch and item on run failure, preventing successor admission', async () => {
      const { batchId } = setupFiveItemBatch();

      // Run 1 fails
      runRepository.atomicUpdateByUuid(
        'run-item-1',
        { status: 'failed', failureReason: 'syntax error' },
        'running',
      );

      const result = await coordinator.reconcile(batchId);
      expect(result.actions).toContain('blocked');
      expect(result.batchStatus).toBe('blocked');

      const saved = releaseBatchRepository.findById(batchId)!;
      expect(saved.status).toBe('blocked');
      expect(saved.blockedReason).toBe('run_failed');
      expect(saved.items[0]?.status).toBe('blocked');
      expect(saved.items[0]?.blockedReason).toBe('run_failed');

      // Subsequent items still pending
      expect(saved.items[1]?.status).toBe('pending');
      expect(saved.items[1]?.runUuid).toBeUndefined();

      // Blocked event published
      const blockedEvent = eventBus.published.find((p) => p.event.type === 'release_batch.blocked');
      expect(blockedEvent).toBeDefined();
      expect(blockedEvent?.event.metadata).toMatchObject({
        releaseBatchId: batchId,
        position: 1,
        issueNumber: 101,
        runUuid: 'run-item-1',
        blockedReason: 'run_failed',
      });
    });

    it('blocks batch and item on run blocked, needs_human_review, and cancelled', async () => {
      for (const [runStatus, reason] of [
        ['blocked', 'run_blocked'],
        ['needs_human_review', 'needs_human_review'],
        ['cancelled', 'run_cancelled'],
      ] as const) {
        releaseBatchRepository = new FakeReleaseBatchRepository();
        runRepository = new FakeRunRepository();
        jobQueue = new FakeJobQueuePort(repositoryPort);
        eventBus = new FakeEventBus();
        coordinator = new ReleaseBatchCoordinator({
          releaseBatchRepository,
          runRepository,
          jobQueue,
          repositoryPort,
          eventBus,
          now: () => t1,
        });

        const { batchId } = setupFiveItemBatch();
        runRepository.atomicUpdateByUuid('run-item-1', { status: runStatus }, 'running');

        const result = await coordinator.reconcile(batchId);
        expect(result.actions).toContain('blocked');

        const saved = releaseBatchRepository.findById(batchId)!;
        expect(saved.status).toBe('blocked');
        expect(saved.blockedReason).toBe(reason);
        expect(saved.items[0]?.status).toBe('blocked');
        expect(saved.items[0]?.blockedReason).toBe(reason);
      }
    });
  });

  describe('Run resume and automatic unblocking', () => {
    it('automatically unblocks batch/item when the same Run is reactivated, preserving run UUID', async () => {
      const { batchId } = setupFiveItemBatch();

      // 1. Run fails and coordinator blocks batch
      runRepository.atomicUpdateByUuid(
        'run-item-1',
        { status: 'failed', failureReason: 'temporary network failure' },
        'running',
      );
      await coordinator.reconcile(batchId);
      expect(releaseBatchRepository.findById(batchId)!.status).toBe('blocked');

      // 2. Run resumes (operator runs `runs resume --uuid ...`)
      runRepository.atomicUpdateByUuid(
        'run-item-1',
        { status: 'running', failureReason: null },
        'failed',
      );

      // 3. Coordinator reconciles
      const result = await coordinator.reconcile(batchId);
      expect(result.actions).toContain('unblocked');
      expect(result.batchStatus).toBe('building');

      const saved = releaseBatchRepository.findById(batchId)!;
      expect(saved.status).toBe('building');
      expect(saved.blockedReason).toBeUndefined();
      expect(saved.items[0]?.status).toBe('active');
      expect(saved.items[0]?.blockedReason).toBeUndefined();
      expect(saved.items[0]?.runUuid).toBe('run-item-1'); // Same Run preserved!

      // Zero replacement Runs created
      expect(runRepository.runs.size).toBe(1);

      // Unblocked event published
      const unblockedEvent = eventBus.published.find(
        (p) => p.event.type === 'release_batch.unblocked',
      );
      expect(unblockedEvent).toBeDefined();
      expect(unblockedEvent?.event.metadata).toMatchObject({
        releaseBatchId: batchId,
        position: 1,
        issueNumber: 101,
        runUuid: 'run-item-1',
      });
    });
  });

  describe('Run passed gate vs merge certification', () => {
    it('does NOT advance solely from Run passed without downstream merge certification', async () => {
      const { batchId } = setupFiveItemBatch();

      // Run completes with passed
      runRepository.atomicUpdateByUuid('run-item-1', { status: 'passed' }, 'running');

      const result = await coordinator.reconcile(batchId);
      expect(result.batchStatus).toBe('building');

      const saved = releaseBatchRepository.findById(batchId)!;
      // Item 1 is NOT merged yet
      expect(saved.items[0]?.status).toBe('active');
      // Item 2 is NOT admitted yet
      expect(saved.items[1]?.status).toBe('pending');
      expect(saved.items[1]?.runUuid).toBeUndefined();

      // No new Run created
      expect(runRepository.runs.size).toBe(1);
    });

    it('admits successor once downstream merge barrier certifies item merged', async () => {
      const { batchId } = setupFiveItemBatch();

      // Downstream merge barrier certifies item 1 merged
      const result = await coordinator.certifyItemMerged({
        batchId,
        position: 1,
        mergedCommitSha: 'sha-commit-101',
        now: t2,
      });

      expect(result.batchStatus).toBe('building');
      expect(result.actions).toContain('successor_admitted');

      const saved = releaseBatchRepository.findById(batchId)!;
      // Item 1 is merged
      expect(saved.items[0]?.status).toBe('merged');
      expect(saved.items[0]?.mergedCommitSha).toBe('sha-commit-101');

      // Item 2 is admitted!
      expect(saved.items[1]?.status).toBe('active');
      expect(saved.items[1]?.runUuid).toBeDefined();
      expect(saved.items[1]?.baseSha).toBe('sha-commit-101'); // Admitted with merged SHA of item 1

      // Items 3..5 remain pending
      for (let i = 2; i < 5; i++) {
        expect(saved.items[i]?.status).toBe('pending');
        expect(saved.items[i]?.runUuid).toBeUndefined();
      }

      // Exactly 2 runs now exist (item 1 and item 2)
      expect(runRepository.runs.size).toBe(2);
      const run2 = runRepository.findByUuid(saved.items[1]?.runUuid!);
      expect(run2?.baseBranch).toBe(saved.releaseBranch);
      expect(run2?.issueNumber).toBe(102);

      // Job queued for item 2
      const activeJobs = jobQueue.listActive();
      expect(
        activeJobs.find((j) => (j.runId as unknown as string) === saved.items[1]?.runUuid),
      ).toBeDefined();
    });

    it('completes build-stage sequencing after final item is certified merged', async () => {
      const { batchId } = setupFiveItemBatch();

      // Progress through all 5 items
      for (let pos = 1; pos <= 5; pos++) {
        await coordinator.certifyItemMerged({
          batchId,
          position: pos,
          mergedCommitSha: `sha-commit-${100 + pos}`,
          now: t2,
        });
      }

      const saved = releaseBatchRepository.findById(batchId)!;
      for (let pos = 1; pos <= 5; pos++) {
        expect(saved.items[pos - 1]?.status).toBe('merged');
      }

      // Reconciliation acknowledges build stage completion
      const result = await coordinator.reconcile(batchId);
      expect(result.actions).toContain('build_completed');

      const completedEvent = eventBus.published.find(
        (p) => p.event.type === 'release_batch.build_stage_completed',
      );
      expect(completedEvent).toBeDefined();
      expect(completedEvent?.event.metadata).toMatchObject({
        releaseBatchId: batchId,
        totalItems: 5,
      });
    });
  });

  describe('Crash windows & idempotency', () => {
    it('Window 1: recovers missing Job when item was marked active before initial Job enqueue', async () => {
      const batchId = ReleaseBatchId('batch-crash-w1');
      let batch = createReleaseBatch({
        id: batchId,
        repoId: defaultRepo.id,
        sourceBranch: 'main',
        sourceStartSha: 'sha-root-000',
        releaseBranch: 'release/w1',
        createdAt: t0,
        items: [{ position: 1, issueNumber: 101 }],
      });
      batch = admitItem(batch, 1, { runUuid: 'run-w1', now: t0 });
      releaseBatchRepository.insert(batch);

      // Run exists in DB but process crashed before jobQueue.enqueue
      runRepository.insertIfNoActive({
        uuid: 'run-w1',
        displayId: 'issue-101-w1',
        repoId: defaultRepo.id,
        issueNumber: 101,
        startedAt: t0,
        type: 'issue_to_pr',
        baseBranch: 'release/w1',
        status: 'running',
        completedPhases: [],
        skippedPhases: [],
      });
      expect(jobQueue.listActive()).toHaveLength(0);

      // Reconcile detects missing job and enqueues it
      const result = await coordinator.reconcile(batchId);
      expect(result.actions).toContain('job_recovered');
      expect(jobQueue.listActive()).toHaveLength(1);

      // Repeated reconcile is idempotent: does not duplicate Job
      const result2 = await coordinator.reconcile(batchId);
      expect(result2.actions).not.toContain('job_recovered');
      expect(jobQueue.listActive()).toHaveLength(1);
    });

    it('Window 2: adopts existing Run when Run was created before item stored Run UUID', async () => {
      const batchId = ReleaseBatchId('batch-crash-w2');
      const batch = createReleaseBatch({
        id: batchId,
        repoId: defaultRepo.id,
        sourceBranch: 'main',
        sourceStartSha: 'sha-root-000',
        releaseBranch: 'release/w2',
        createdAt: t0,
        items: [{ position: 1, issueNumber: 101 }],
      });
      // Item is pending with NO runUuid in releaseBatchRepository
      releaseBatchRepository.insert(batch);

      // But Run was already created in runRepository targeting release/w2
      runRepository.insertIfNoActive({
        uuid: 'run-already-created',
        displayId: 'issue-101-already',
        repoId: defaultRepo.id,
        issueNumber: 101,
        startedAt: t0,
        type: 'issue_to_pr',
        baseBranch: 'release/w2',
        status: 'queued',
        completedPhases: [],
        skippedPhases: [],
      });

      // Reconcile should adopt existing Run without throwing duplicate conflict
      const result = await coordinator.reconcile(batchId);
      expect(result.actions).toContain('run_adopted');

      const saved = releaseBatchRepository.findById(batchId)!;
      expect(saved.items[0]?.runUuid).toBe('run-already-created');
      expect(saved.items[0]?.status).toBe('active');
      expect(runRepository.runs.size).toBe(1); // No second run
    });

    it('Window 3: current item certified merged before successor admission recovers on next cycle', async () => {
      const { batchId } = setupFiveItemBatch();

      // Simulate crash right after item 1 was marked merged in repository
      let batch = releaseBatchRepository.findById(batchId)!;
      const { markItemMerged } = await import('@ai-sdlc/domain');
      batch = markItemMerged(batch, 1, { mergedCommitSha: 'sha-commit-101' });
      releaseBatchRepository.update(batch);

      // Item 2 is still pending
      expect(batch.items[1]?.status).toBe('pending');
      expect(batch.items[1]?.runUuid).toBeUndefined();

      // Reconciliation recovers and admits successor cleanly
      const result = await coordinator.reconcile(batchId);
      expect(result.actions).toContain('successor_admitted');

      const saved = releaseBatchRepository.findById(batchId)!;
      expect(saved.items[1]?.status).toBe('active');
      expect(saved.items[1]?.runUuid).toBeDefined();
    });

    it('Window 4: successor Run created before item stores its UUID adopts successor Run without duplicate', async () => {
      const { batchId } = setupFiveItemBatch();

      // Item 1 is marked merged in batch repository
      let batch = releaseBatchRepository.findById(batchId)!;
      const { markItemMerged } = await import('@ai-sdlc/domain');
      batch = markItemMerged(batch, 1, { mergedCommitSha: 'sha-commit-101' });
      releaseBatchRepository.update(batch);

      // Simulate crash: successor Run for issue 102 was created in runRepository,
      // but process crashed before batch item 2 stored runUuid
      runRepository.insertIfNoActive({
        uuid: 'run-successor-precreated',
        displayId: 'issue-102-precreated',
        repoId: defaultRepo.id,
        issueNumber: 102,
        startedAt: t1,
        type: 'issue_to_pr',
        baseBranch: batch.releaseBranch,
        status: 'queued',
        completedPhases: [],
        skippedPhases: [],
      });

      // Reconcile should find existing run for issue 102 targeting releaseBranch and adopt it
      const result = await coordinator.reconcile(batchId);
      expect(result.actions).toContain('run_adopted');
      expect(result.actions).toContain('successor_admitted');

      const saved = releaseBatchRepository.findById(batchId)!;
      expect(saved.items[1]?.status).toBe('active');
      expect(saved.items[1]?.runUuid).toBe('run-successor-precreated');
      expect(runRepository.runs.size).toBe(2); // Exactly 2 runs: item 1 and adopted item 2
    });

    it('Window 5: repeated/reentrant reconciliation calls are strictly idempotent', async () => {
      const { batchId } = setupFiveItemBatch();

      // Call reconcile multiple times in sequence
      const res1 = await coordinator.reconcile(batchId);
      const res2 = await coordinator.reconcile(batchId);
      const res3 = await coordinator.reconcile(batchId);

      expect(res1.batchStatus).toBe('building');
      expect(res2.batchStatus).toBe('building');
      expect(res3.batchStatus).toBe('building');

      expect(runRepository.runs.size).toBe(1);
      expect(jobQueue.listActive()).toHaveLength(1);
    });

    it('Window 6: operator resumes current Run while coordinator is reconciling', async () => {
      const { batchId } = setupFiveItemBatch();

      // Mark blocked
      runRepository.atomicUpdateByUuid(
        'run-item-1',
        { status: 'blocked', failureReason: 'blocked' },
        'running',
      );
      await coordinator.reconcile(batchId);

      // Concurrent resume: operator reactivates run
      runRepository.atomicUpdateByUuid(
        'run-item-1',
        { status: 'running', failureReason: null },
        'blocked',
      );

      // Coordinator reconciles again
      const res = await coordinator.reconcile(batchId);
      expect(res.actions).toContain('unblocked');

      const saved = releaseBatchRepository.findById(batchId)!;
      expect(saved.status).toBe('building');
      expect(saved.items[0]?.runUuid).toBe('run-item-1');
      expect(runRepository.runs.size).toBe(1);
    });
  });

  describe('PR metadata attachment & waiting_merge transition', () => {
    it('attaches PR metadata and transitions active item to waiting_merge when run is waiting', async () => {
      coordinator = new ReleaseBatchCoordinator({
        releaseBatchRepository,
        runRepository,
        jobQueue,
        repositoryPort,
        eventBus,
        resolvePrMetadata: async (run) => {
          if (run.issueNumber === 101) return { prNumber: 88 };
          return undefined;
        },
        now: () => t1,
      });

      const { batchId } = setupFiveItemBatch();

      // Run transitions to waiting
      runRepository.atomicUpdateByUuid('run-item-1', { status: 'waiting' }, 'running');

      const result = await coordinator.reconcile(batchId);
      expect(result.actions).toContain('pr_attached');

      const saved = releaseBatchRepository.findById(batchId)!;
      expect(saved.items[0]?.status).toBe('waiting_merge');
      expect(saved.items[0]?.prNumber).toBe(88);

      const prEvent = eventBus.published.find(
        (p) => p.event.type === 'release_batch.item_waiting_merge',
      );
      expect(prEvent).toBeDefined();
      expect(prEvent?.event.metadata).toMatchObject({
        releaseBatchId: batchId,
        position: 1,
        issueNumber: 101,
        runUuid: 'run-item-1',
        prNumber: 88,
      });
    });
  });

  describe('PR merge readiness & failure reconciliation', () => {
    let fakeGitHub: FakeGitHubPort;
    let fakeGit: FakeGitPort;

    beforeEach(() => {
      fakeGitHub = new FakeGitHubPort();
      fakeGit = new FakeGitPort();
      coordinator = new ReleaseBatchCoordinator({
        releaseBatchRepository,
        runRepository,
        jobQueue,
        repositoryPort,
        eventBus,
        git: fakeGit,
        github: fakeGitHub,
        resolvePrMetadata: async (run) => {
          if (run.issueNumber === 101) return { prNumber: 88 };
          return undefined;
        },
        now: () => t1,
      });
    });

    it('transitions active item to waiting_merge when PR is open and rests without holding worker lease', async () => {
      const { batchId } = setupFiveItemBatch();
      fakeGitHub.mergeReadiness.set(`${defaultRepo.fullName}/88`, {
        prNumber: 88,
        state: 'open',
        isMerged: false,
        ciStatus: 'pending',
        autoMergeEnabled: true,
        baseRefName: 'release/2026-09-11-batch-five',
      });

      const result = await coordinator.reconcile(batchId);
      expect(result.actions).toContain('pr_attached');

      const saved = releaseBatchRepository.findById(batchId)!;
      expect(saved.items[0]?.status).toBe('waiting_merge');
      expect(saved.items[0]?.prNumber).toBe(88);
      expect(saved.status).toBe('building');
    });

    it('blocks batch and item when PR CI checks fail without creating a new Run UUID', async () => {
      const { batchId } = setupFiveItemBatch();
      fakeGitHub.mergeReadiness.set(`${defaultRepo.fullName}/88`, {
        prNumber: 88,
        state: 'open',
        isMerged: false,
        ciStatus: 'failed',
        autoMergeEnabled: true,
        baseRefName: 'release/2026-09-11-batch-five',
      });

      const result = await coordinator.reconcile(batchId);
      expect(result.actions).toContain('blocked');
      expect(result.batchStatus).toBe('blocked');

      const saved = releaseBatchRepository.findById(batchId)!;
      expect(saved.status).toBe('blocked');
      expect(saved.items[0]?.status).toBe('blocked');
      expect(saved.items[0]?.blockedReason).toContain('ci_failed');
      expect(saved.items[0]?.runUuid).toBe('run-item-1');
      expect(runRepository.runs.size).toBe(1); // No new Run UUID
    });

    it('unblocks batch and item when PR CI checks recover to passed without creating a new Run UUID', async () => {
      const { batchId } = setupFiveItemBatch();
      // Initially failed
      fakeGitHub.mergeReadiness.set(`${defaultRepo.fullName}/88`, {
        prNumber: 88,
        state: 'open',
        isMerged: false,
        ciStatus: 'failed',
        autoMergeEnabled: true,
        baseRefName: 'release/2026-09-11-batch-five',
      });
      await coordinator.reconcile(batchId);

      // Now CI passes
      fakeGitHub.mergeReadiness.set(`${defaultRepo.fullName}/88`, {
        prNumber: 88,
        state: 'open',
        isMerged: false,
        ciStatus: 'passed',
        autoMergeEnabled: true,
        baseRefName: 'release/2026-09-11-batch-five',
      });

      const result = await coordinator.reconcile(batchId);
      expect(result.actions).toContain('unblocked');
      expect(result.batchStatus).toBe('building');

      const saved = releaseBatchRepository.findById(batchId)!;
      expect(saved.status).toBe('building');
      expect(saved.items[0]?.status).toBe('waiting_merge');
      expect(saved.items[0]?.runUuid).toBe('run-item-1');
      expect(runRepository.runs.size).toBe(1); // Same run preserved
    });

    it('blocks batch when PR is closed unmerged', async () => {
      const { batchId } = setupFiveItemBatch();
      fakeGitHub.mergeReadiness.set(`${defaultRepo.fullName}/88`, {
        prNumber: 88,
        state: 'closed',
        isMerged: false,
        ciStatus: 'passed',
        autoMergeEnabled: false,
        baseRefName: 'release/2026-09-11-batch-five',
      });

      const result = await coordinator.reconcile(batchId);
      expect(result.actions).toContain('blocked');

      const saved = releaseBatchRepository.findById(batchId)!;
      expect(saved.status).toBe('blocked');
      expect(saved.items[0]?.status).toBe('blocked');
      expect(saved.items[0]?.blockedReason).toContain('pr_closed_unmerged');
      expect(runRepository.runs.size).toBe(1);
    });

    it('blocks batch when PR base branch mismatches batch releaseBranch', async () => {
      const { batchId } = setupFiveItemBatch();
      fakeGitHub.mergeReadiness.set(`${defaultRepo.fullName}/88`, {
        prNumber: 88,
        state: 'open',
        isMerged: false,
        ciStatus: 'passed',
        autoMergeEnabled: true,
        baseRefName: 'main', // mismatches release/2026-09-11-batch-five
      });

      const result = await coordinator.reconcile(batchId);
      expect(result.actions).toContain('blocked');

      const saved = releaseBatchRepository.findById(batchId)!;
      expect(saved.status).toBe('blocked');
      expect(saved.items[0]?.status).toBe('blocked');
      expect(saved.items[0]?.blockedReason).toContain('pr_base_mismatch');
      expect(runRepository.runs.size).toBe(1);
    });

    it('blocks batch when auto-merge is disabled on PR', async () => {
      const { batchId } = setupFiveItemBatch();
      fakeGitHub.mergeReadiness.set(`${defaultRepo.fullName}/88`, {
        prNumber: 88,
        state: 'open',
        isMerged: false,
        ciStatus: 'passed',
        autoMergeEnabled: false,
        baseRefName: 'release/2026-09-11-batch-five',
      });

      const result = await coordinator.reconcile(batchId);
      expect(result.actions).toContain('blocked');

      const saved = releaseBatchRepository.findById(batchId)!;
      expect(saved.status).toBe('blocked');
      expect(saved.items[0]?.status).toBe('blocked');
      expect(saved.items[0]?.blockedReason).toContain('auto_merge_unavailable');
      expect(runRepository.runs.size).toBe(1);
    });

    it('certifies item merged when PR is merged and advances batch', async () => {
      const { batchId } = setupFiveItemBatch();
      fakeGit.remoteRefs.set('origin/release/2026-09-11-batch-five', 'sha-fresh-merged-101');
      fakeGitHub.mergeReadiness.set(`${defaultRepo.fullName}/88`, {
        prNumber: 88,
        state: 'merged',
        isMerged: true,
        ciStatus: 'passed',
        autoMergeEnabled: true,
        baseRefName: 'release/2026-09-11-batch-five',
        mergeCommitSha: 'sha-fresh-merged-101',
      });

      const result = await coordinator.reconcile(batchId);
      expect(result.actions).toContain('successor_admitted');

      const saved = releaseBatchRepository.findById(batchId)!;
      expect(saved.items[0]?.status).toBe('merged');
      expect(saved.items[0]?.mergedCommitSha).toBe('sha-fresh-merged-101');
      expect(saved.items[1]?.status).toBe('active');
      expect(saved.items[1]?.baseSha).toBe('sha-fresh-merged-101');
    });
  });

  describe('inter-item maintenance and health thresholds', () => {
    let fakeGitHub: FakeGitHubPort;
    let fakeGit: FakeGitPort;
    let fakeHealth: FakeEnvironmentHealthPort;
    let maintenanceService: InterItemMaintenanceService;

    beforeEach(() => {
      fakeGitHub = new FakeGitHubPort();
      fakeGit = new FakeGitPort();
      fakeHealth = new FakeEnvironmentHealthPort();
      maintenanceService = new InterItemMaintenanceService({
        orphanReaper: new ReapOrphanedTestWorkers({
          listProcesses: async () => [],
          killProcess: () => true,
        }),
        git: fakeGit,
        health: fakeHealth,
      });

      coordinator = new ReleaseBatchCoordinator({
        releaseBatchRepository,
        runRepository,
        jobQueue,
        repositoryPort,
        eventBus,
        git: fakeGit,
        github: fakeGitHub,
        maintenanceService,
        resolvePrMetadata: async (run) => {
          if (run.issueNumber === 101) return { prNumber: 88 };
          return undefined;
        },
        now: () => t1,
      });
    });

    it('executes maintenance before admitting successor and admits with fresh base', async () => {
      const { batchId } = setupFiveItemBatch();
      const worktreePath = `${defaultRepo.localBasePath}/.ai-worktrees/issue-101`;
      fakeGit.worktrees.push(worktreePath);
      fakeGit.remoteRefs.set('origin/release/2026-09-11-batch-five', 'sha-merged-item-1');

      fakeGitHub.mergeReadiness.set(`${defaultRepo.fullName}/88`, {
        prNumber: 88,
        state: 'merged',
        isMerged: true,
        ciStatus: 'passed',
        autoMergeEnabled: true,
        baseRefName: 'release/2026-09-11-batch-five',
        mergeCommitSha: 'sha-merged-item-1',
      });

      const result = await coordinator.reconcile(batchId);
      expect(result.actions).toContain('maintenance_run');
      expect(result.actions).toContain('successor_admitted');

      // Completed worktree removed
      expect(fakeGit.worktrees.includes(worktreePath)).toBe(false);

      const saved = releaseBatchRepository.findById(batchId)!;
      expect(saved.items[1]?.status).toBe('active');
      expect(saved.items[1]?.baseSha).toBe('sha-merged-item-1');

      // Verify runRepository was updated with fresh startCommitSha
      const run2 = runRepository.findByUuid(saved.items[1]?.runUuid!);
      expect(run2?.startCommitSha).toBe('sha-merged-item-1');
    });

    it('blocks batch when environment health check fails and admits nothing', async () => {
      const { batchId } = setupFiveItemBatch();
      fakeGit.remoteRefs.set('origin/release/2026-09-11-batch-five', 'sha-merged-item-1');

      fakeHealth.diskFreeMb = 1024;

      const result = await coordinator.certifyItemMerged({
        batchId,
        position: 1,
        mergedCommitSha: 'sha-merged-item-1',
        now: t1,
      });

      expect(result.actions).toContain('blocked');
      expect(result.batchStatus).toBe('blocked');

      const saved = releaseBatchRepository.findById(batchId)!;
      expect(saved.status).toBe('blocked');
      expect(saved.blockedReason).toContain('Disk free space (1024MB) is below required floor');

      // Item 2 remains pending!
      expect(saved.items[1]?.status).toBe('pending');
      expect(saved.items[1]?.runUuid).toBeUndefined();
      expect(runRepository.runs.size).toBe(1); // No successor run created
    });

    it('retries maintenance idempotently and admits successor once environment health recovers', async () => {
      const { batchId } = setupFiveItemBatch();
      fakeGit.remoteRefs.set('origin/release/2026-09-11-batch-five', 'sha-merged-item-1');

      fakeHealth.diskFreeMb = 1024;

      await coordinator.certifyItemMerged({
        batchId,
        position: 1,
        mergedCommitSha: 'sha-merged-item-1',
        now: t1,
      });

      let saved = releaseBatchRepository.findById(batchId)!;
      expect(saved.status).toBe('blocked');

      // Disk space recovered!
      fakeHealth.diskFreeMb = 5120;

      const retryResult = await coordinator.reconcile(batchId);
      expect(retryResult.actions).toContain('unblocked');
      expect(retryResult.actions).toContain('successor_admitted');

      saved = releaseBatchRepository.findById(batchId)!;
      expect(saved.status).toBe('building');
      expect(saved.items[1]?.status).toBe('active');
      expect(saved.items[1]?.runUuid).toBeDefined();
      expect(saved.items[1]?.baseSha).toBe('sha-merged-item-1');
      expect(runRepository.runs.size).toBe(2);
    });
  });

  describe('fresh release-base certification', () => {
    let fakeGitHub: FakeGitHubPort;
    let fakeGit: FakeGitPort;

    beforeEach(() => {
      fakeGitHub = new FakeGitHubPort();
      fakeGit = new FakeGitPort();
      coordinator = new ReleaseBatchCoordinator({
        releaseBatchRepository,
        runRepository,
        jobQueue,
        repositoryPort,
        eventBus,
        git: fakeGit,
        github: fakeGitHub,
        now: () => t1,
      });
    });

    it('stale local branch regression test: successor branches from fresh remote SHA, not stale local branch', async () => {
      const { batchId } = setupFiveItemBatch();

      // Local repo head/branch has stale SHA
      const staleLocalSha = 'sha-stale-local-12345';
      fakeGit.headByCwd.set(defaultRepo.localBasePath, staleLocalSha);

      // Remote release branch on origin has fresh merged SHA
      const freshRemoteSha = 'sha-fresh-remote-98765';
      fakeGit.remoteRefs.set('origin/release/2026-09-11-batch-five', freshRemoteSha);

      // Certify item 1 merged
      const result = await coordinator.certifyItemMerged({
        batchId,
        position: 1,
        mergedCommitSha: 'sha-item-1-merged',
        now: t1,
      });

      expect(result.actions).toContain('successor_admitted');

      const saved = releaseBatchRepository.findById(batchId)!;
      const item2 = saved.items[1]!;
      expect(item2.status).toBe('active');

      // Successor baseSha MUST be freshRemoteSha, NOT staleLocalSha!
      expect(item2.baseSha).toBe(freshRemoteSha);
      expect(item2.baseSha).not.toBe(staleLocalSha);

      // Successor run startCommitSha in runRepository MUST be freshRemoteSha!
      const run2 = runRepository.findByUuid(item2.runUuid!);
      expect(run2?.startCommitSha).toBe(freshRemoteSha);
      expect(run2?.startCommitSha).not.toBe(staleLocalSha);

      // Verify fetch was called for origin/release/2026-09-11-batch-five
      expect(fakeGit.fetchCalls).toContainEqual({
        cwd: defaultRepo.localBasePath,
        remote: 'origin',
        ref: 'release/2026-09-11-batch-five',
      });
    });
  });

  describe('repeated reconciliation idempotency', () => {
    it('repeated reconciliation cannot admit successor twice or create duplicate runs', async () => {
      const fakeGit = new FakeGitPort();
      fakeGit.remoteRefs.set('origin/release/2026-09-11-batch-five', 'sha-item-1');
      coordinator = new ReleaseBatchCoordinator({
        releaseBatchRepository,
        runRepository,
        jobQueue,
        repositoryPort,
        eventBus,
        git: fakeGit,
        now: () => t1,
      });

      const { batchId } = setupFiveItemBatch();

      // Certify item 1 merged -> admits item 2
      const res1 = await coordinator.certifyItemMerged({
        batchId,
        position: 1,
        mergedCommitSha: 'sha-item-1',
        now: t1,
      });
      expect(res1.actions).toContain('successor_admitted');
      expect(runRepository.runs.size).toBe(2);

      const saved1 = releaseBatchRepository.findById(batchId)!;
      const item2RunUuid = saved1.items[1]?.runUuid;
      expect(item2RunUuid).toBeDefined();

      // Reconcile again (and again)
      const res2 = await coordinator.reconcile(batchId);
      expect(res2.actions).not.toContain('successor_admitted');
      expect(runRepository.runs.size).toBe(2); // Still exactly 2 runs

      const res3 = await coordinator.reconcile(batchId);
      expect(res3.actions).not.toContain('successor_admitted');
      expect(runRepository.runs.size).toBe(2);

      const saved3 = releaseBatchRepository.findById(batchId)!;
      expect(saved3.items[1]?.runUuid).toBe(item2RunUuid); // Same run UUID
      expect(saved3.items[2]?.status).toBe('pending'); // Item 3 still pending
      expect(saved3.items[2]?.runUuid).toBeUndefined();
    });
  });

  describe('reconcileAll', () => {
    it('reconciles all active batches for repository', async () => {
      const { batchId } = setupFiveItemBatch();

      const results = await coordinator.reconcileAll(defaultRepo.id);
      expect(results).toHaveLength(1);
      expect(results[0]?.batchId).toBe(batchId);
    });
  });

  describe('candidate capture and promotion lifecycle', () => {
    let fakeGit: FakeGitPort;
    let fakeGitHub: FakeGitHubPort;

    beforeEach(() => {
      fakeGit = new FakeGitPort();
      fakeGitHub = new FakeGitHubPort();
      coordinator = new ReleaseBatchCoordinator({
        releaseBatchRepository,
        runRepository,
        jobQueue,
        repositoryPort,
        eventBus,
        git: fakeGit,
        github: fakeGitHub,
        now: () => t1,
      });
    });

    it('captures candidate SHA and tree SHA and transitions to awaiting_manual_test after final item merges', async () => {
      const { batchId } = setupFiveItemBatch();
      const finalSha = 'sha-commit-105';
      fakeGit.remoteRefs.set('origin/release/2026-09-11-batch-five', finalSha);
      fakeGit.remoteRefs.set('origin/main', 'sha-root-000');
      fakeGit.treeShaResults.set(finalSha, 'tree-105');
      fakeGit.ancestorResults.set(`sha-root-000|${finalSha}`, true);

      let lastResult;
      // Certify all 5 items merged
      for (let pos = 1; pos <= 5; pos++) {
        lastResult = await coordinator.certifyItemMerged({
          batchId,
          position: pos,
          mergedCommitSha: `sha-commit-${100 + pos}`,
          now: t1,
        });
      }

      expect(lastResult?.actions).toContain('candidate_captured');
      expect(lastResult?.batchStatus).toBe('awaiting_manual_test');

      const saved = releaseBatchRepository.findById(batchId)!;
      expect(saved.status).toBe('awaiting_manual_test');
      expect(saved.candidateSha).toBe(finalSha);
      expect(saved.candidateTreeSha).toBe('tree-105');
    });

    it('blocks candidate capture with source_branch_advanced when source branch drifted ahead', async () => {
      const { batchId } = setupFiveItemBatch();
      const finalSha = 'sha-commit-105';
      const driftedSourceSha = 'sha-main-drifted-999';
      fakeGit.remoteRefs.set('origin/release/2026-09-11-batch-five', finalSha);
      fakeGit.remoteRefs.set('origin/main', driftedSourceSha);
      // origin/main is NOT an ancestor of release candidate
      fakeGit.ancestorResults.set(`${driftedSourceSha}|${finalSha}`, false);

      let lastResult;
      for (let pos = 1; pos <= 5; pos++) {
        lastResult = await coordinator.certifyItemMerged({
          batchId,
          position: pos,
          mergedCommitSha: `sha-commit-${100 + pos}`,
          now: t1,
        });
      }

      expect(lastResult?.actions).toContain('blocked');
      expect(lastResult?.actions).toContain('source_drift_detected');
      expect(lastResult?.batchStatus).toBe('blocked');

      const saved = releaseBatchRepository.findById(batchId)!;
      expect(saved.status).toBe('blocked');
      expect(saved.blockedReason).toBe('source_branch_advanced');
      expect(saved.candidateSha).toBeUndefined();
    });

    it('integrateSourceBranch merges source into release branch and enables candidate capture', async () => {
      const { batchId } = setupFiveItemBatch();
      const finalSha = 'sha-commit-105';
      const driftedSourceSha = 'sha-main-drifted-999';
      fakeGit.remoteRefs.set('origin/release/2026-09-11-batch-five', finalSha);
      fakeGit.remoteRefs.set('origin/main', driftedSourceSha);
      fakeGit.ancestorResults.set(`${driftedSourceSha}|${finalSha}`, false);

      for (let pos = 1; pos <= 5; pos++) {
        await coordinator.certifyItemMerged({
          batchId,
          position: pos,
          mergedCommitSha: `sha-commit-${100 + pos}`,
          now: t1,
        });
      }

      // Now prepare git for integrateSourceBranch:
      const integratedSha = 'sha-commit-integrated-merge';
      fakeGit.headByCwd.set(defaultRepo.localBasePath, integratedSha);
      // Simulate remote updated on push
      fakeGit.remoteRefs.set('origin/release/2026-09-11-batch-five', integratedSha);
      fakeGit.ancestorResults.set(`${driftedSourceSha}|${integratedSha}`, true);
      fakeGit.treeShaResults.set(integratedSha, 'tree-integrated');

      const integrated = await coordinator.integrateSourceBranch(batchId);
      expect(integrated.success).toBe(true);
      expect(integrated.newReleaseSha).toBe(integratedSha);

      const saved = releaseBatchRepository.findById(batchId)!;
      expect(saved.status).toBe('awaiting_manual_test');
      expect(saved.candidateSha).toBe(integratedSha);
      expect(saved.candidateTreeSha).toBe('tree-integrated');
    });

    it('reconciles promotion PR merge and marks batch completed', async () => {
      const { batchId } = setupFiveItemBatch();
      const candidateSha = 'sha-candidate-456';
      const promotionSha = 'sha-promoted-commit-789';

      let batch = releaseBatchRepository.findById(batchId)!;
      // Mark all items merged
      for (const item of batch.items) {
        item.status = 'merged';
        item.mergedCommitSha = 'sha-item-' + item.position;
      }
      batch.candidateSha = candidateSha;
      batch.approvedCandidateSha = candidateSha;
      batch.candidateTreeSha = 'tree-candidate-456';
      batch.status = 'promoting';
      batch.promotionPrNumber = 42;
      releaseBatchRepository.update(batch);

      // Setup fake GitHub PR readiness
      fakeGitHub.prs.set('test-org/test-repo/42', {
        number: 42,
        url: 'https://example/pr/42',
        state: 'merged',
        headRefName: batch.releaseBranch,
        baseRefName: batch.sourceBranch,
      });
      fakeGitHub.mergeReadiness.set('test-org/test-repo/42', {
        prNumber: 42,
        state: 'merged',
        isMerged: true,
        ciStatus: 'passed',
        mergeStateStatus: 'clean',
        baseRefName: batch.sourceBranch,
        autoMergeEnabled: true,
        mergeCommitSha: promotionSha,
      });

      // Setup Git
      fakeGit.remoteRefs.set('origin/' + batch.sourceBranch, promotionSha);
      fakeGit.ancestorResults.set(`${candidateSha}|${promotionSha}`, true);

      const result = await coordinator.reconcile(batchId);
      expect(result.actions).toContain('promotion_completed');
      expect(result.batchStatus).toBe('completed');

      const saved = releaseBatchRepository.findById(batchId)!;
      expect(saved.status).toBe('completed');
      expect(saved.promotionCommitSha).toBe(promotionSha);
      expect(saved.completedAt).toBeDefined();
    });
  });
});
