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

  describe('reconcileAll', () => {
    it('reconciles all active batches for repository', async () => {
      const { batchId } = setupFiveItemBatch();

      const results = await coordinator.reconcileAll(defaultRepo.id);
      expect(results).toHaveLength(1);
      expect(results[0]?.batchId).toBe(batchId);
    });
  });
});
