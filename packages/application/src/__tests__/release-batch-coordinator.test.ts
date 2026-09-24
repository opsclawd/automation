import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  RepositoryId,
  ReleaseBatchId,
  createReleaseBatch,
  admitItem,
  markItemMerged,
  appendRemediationItems,
  ReleaseBatchStateError,
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

    it('automatically unblocks batch/item when the Run has progressed all the way to passed', async () => {
      const { batchId } = setupFiveItemBatch();

      // 1. Run fails and coordinator blocks batch
      runRepository.atomicUpdateByUuid(
        'run-item-1',
        { status: 'failed', failureReason: 'temporary network failure' },
        'running',
      );
      await coordinator.reconcile(batchId);
      expect(releaseBatchRepository.findById(batchId)!.status).toBe('blocked');
      expect(releaseBatchRepository.findById(batchId)!.items[0]?.status).toBe('blocked');

      // 2. Run resumes and completes to passed directly (e.g. via direct resume / outside job)
      runRepository.atomicUpdateByUuid(
        'run-item-1',
        { status: 'passed', failureReason: null },
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
      expect(saved.items[0]?.runUuid).toBe('run-item-1');

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

      // 4. Now downstream merge barrier can certify item merged without error
      const certifyResult = await coordinator.certifyItemMerged({
        batchId,
        position: 1,
        mergedCommitSha: 'sha-commit-101',
        now: t2,
      });
      expect(certifyResult.actions).toContain('successor_admitted');
      const certifiedSaved = releaseBatchRepository.findById(batchId)!;
      expect(certifiedSaved.items[0]?.status).toBe('merged');
      expect(certifiedSaved.items[1]?.status).toBe('active');
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

    it('certifyItemMerged finalizes underlying run from needs_human_review to passed in runRepository', async () => {
      const { batchId } = setupFiveItemBatch();

      // Put item 1 run in needs_human_review at fix-validate phase
      runRepository.update('run-item-1', {
        status: 'needs_human_review',
        currentPhase: 'fix-validate',
      });
      expect(runRepository.findByUuid('run-item-1')?.status).toBe('needs_human_review');
      expect(runRepository.findByUuid('run-item-1')?.currentPhase).toBe('fix-validate');

      // Certify item 1 merged
      await coordinator.certifyItemMerged({
        batchId,
        position: 1,
        mergedCommitSha: 'sha-commit-101',
        now: t2,
      });

      const updatedRun = runRepository.findByUuid('run-item-1')!;
      expect(updatedRun.status).toBe('passed');
      expect(updatedRun.currentPhase).toBeUndefined();
    });

    it('reconcile self-heals stranded non-passed runs for merged items', async () => {
      const { batchId } = setupFiveItemBatch();

      // Manually set item 1 to merged in batch repo, but leave run as needs_human_review in run repo
      const batch = releaseBatchRepository.findById(batchId)!;
      batch.items[0] = {
        ...batch.items[0]!,
        status: 'merged',
        mergedCommitSha: 'sha-commit-101',
      };
      releaseBatchRepository.update(batch);

      runRepository.update('run-item-1', {
        status: 'needs_human_review',
        currentPhase: 'fix-validate',
      });

      await coordinator.reconcile(batchId);

      const healedRun = runRepository.findByUuid('run-item-1')!;
      expect(healedRun.status).toBe('passed');
      expect(healedRun.currentPhase).toBeUndefined();
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

    it('isolates errors per batch so a failing batch does not stop other batches from reconciling', async () => {
      const { batchId: batchId1 } = setupFiveItemBatch();

      const batchId2 = ReleaseBatchId('batch-second');
      const batch2 = createReleaseBatch({
        id: batchId2,
        repoId: defaultRepo.id,
        sourceBranch: 'main',
        sourceStartSha: 'sha-root-000',
        releaseBranch: 'release/2026-09-11-batch-second',
        createdAt: t0,
        items: [{ position: 1, issueNumber: 201 }],
      });
      releaseBatchRepository.insert(batch2);

      const warnSpy = vi.fn();
      coordinator = new ReleaseBatchCoordinator({
        releaseBatchRepository,
        runRepository,
        jobQueue,
        repositoryPort,
        eventBus,
        logger: { warn: warnSpy },
        now: () => t1,
      });

      // Cause batchId1 to throw during reconcile by mocking findById
      const origFindById = releaseBatchRepository.findById.bind(releaseBatchRepository);
      vi.spyOn(releaseBatchRepository, 'findById').mockImplementation((id) => {
        if (id === batchId1) {
          throw new Error('Database disk error on batch 1');
        }
        return origFindById(id);
      });

      const results = await coordinator.reconcileAll(defaultRepo.id);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Failed reconciling release batch batch-five-items: Database disk error on batch 1',
        ),
      );
      expect(results).toHaveLength(1);
      expect(results[0]?.batchId).toBe(batchId2);
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
      expect(lastResult?.actions).toContain('promotion_pr_created');
      expect(lastResult?.batchStatus).toBe('awaiting_manual_test');

      const saved = releaseBatchRepository.findById(batchId)!;
      expect(saved.status).toBe('awaiting_manual_test');
      expect(saved.candidateSha).toBe(finalSha);
      expect(saved.candidateTreeSha).toBe('tree-105');
      expect(saved.promotionPrNumber).toBe(1);
      expect(fakeGitHub.createdPrInputs).toHaveLength(1);
      expect(fakeGitHub.createdPrInputs[0]?.headBranch).toBe('release/2026-09-11-batch-five');
      expect(fakeGitHub.createdPrInputs[0]?.baseBranch).toBe('main');
      expect(fakeGitHub.createdPrInputs[0]?.body).toContain('Closes #101');
      expect(fakeGitHub.createdPrInputs[0]?.body).toContain('Closes #105');
      expect(fakeGitHub.autoMergeRequests).toHaveLength(0); // auto-merge disabled by default
    });

    it('idempotently reuses existing promotionPrNumber on subsequent reconcile', async () => {
      const { batchId } = setupFiveItemBatch();
      const finalSha = 'sha-commit-105';
      fakeGit.remoteRefs.set('origin/release/2026-09-11-batch-five', finalSha);
      fakeGit.remoteRefs.set('origin/main', 'sha-root-000');
      fakeGit.treeShaResults.set(finalSha, 'tree-105');
      fakeGit.ancestorResults.set(`sha-root-000|${finalSha}`, true);

      // Certify all 5 items merged
      for (let pos = 1; pos <= 5; pos++) {
        await coordinator.certifyItemMerged({
          batchId,
          position: pos,
          mergedCommitSha: `sha-commit-${100 + pos}`,
          now: t1,
        });
      }

      expect(fakeGitHub.createdPrInputs).toHaveLength(1);

      // Reconcile again while in awaiting_manual_test
      const secondResult = await coordinator.reconcile(batchId);
      expect(secondResult.batchStatus).toBe('awaiting_manual_test');
      expect(secondResult.actions).not.toContain('promotion_pr_created');
      // Still exactly 1 PR created, no duplicate
      expect(fakeGitHub.createdPrInputs).toHaveLength(1);
    });

    it('refreshes existing promotion PR body on reconciliation candidate capture (#1258)', async () => {
      const { batchId } = setupFiveItemBatch();
      const finalSha1 = 'sha-commit-105';
      fakeGit.remoteRefs.set('origin/release/2026-09-11-batch-five', finalSha1);
      fakeGit.remoteRefs.set('origin/main', 'sha-root-000');
      fakeGit.treeShaResults.set(finalSha1, 'tree-105');
      fakeGit.ancestorResults.set(`sha-root-000|${finalSha1}`, true);

      // Certify all 5 items merged -> creates PR #1
      for (let pos = 1; pos <= 5; pos++) {
        await coordinator.certifyItemMerged({
          batchId,
          position: pos,
          mergedCommitSha: `sha-commit-${100 + pos}`,
          now: t1,
        });
      }

      expect(fakeGitHub.createdPrInputs).toHaveLength(1);
      const prNumber = fakeGitHub.createdPrs[0]?.number!;
      const initialPr = await fakeGitHub.getPr('test-org/test-repo', prNumber);
      expect(initialPr.body).toContain('| **Candidate SHA** | `sha-commit-105` |');

      // Append remediation item 106 and transition to test_failed -> building
      let batch = releaseBatchRepository.findById(batchId)!;
      batch = { ...batch, status: 'test_failed' };
      releaseBatchRepository.update(batch);

      batch = appendRemediationItems(batch, [106]);
      releaseBatchRepository.update(batch);

      // Admit item 6 and merge it
      batch = admitItem(batch, 6, { runUuid: 'run-item-6', baseSha: finalSha1, now: t2 });
      releaseBatchRepository.update(batch);

      const finalSha2 = 'sha-commit-106';
      fakeGit.remoteRefs.set('origin/release/2026-09-11-batch-five', finalSha2);
      fakeGit.treeShaResults.set(finalSha2, 'tree-106');
      fakeGit.ancestorResults.set(`sha-root-000|${finalSha2}`, true);
      fakeGit.ancestorResults.set(`${finalSha1}|${finalSha2}`, true);

      await coordinator.certifyItemMerged({
        batchId,
        position: 6,
        mergedCommitSha: finalSha2,
        now: t2,
      });

      // Coordinator candidate capture should have refreshed PR #1, not created PR #2
      expect(fakeGitHub.createdPrInputs).toHaveLength(1);
      const refreshedPr = await fakeGitHub.getPr('test-org/test-repo', prNumber);
      expect(refreshedPr.body).toContain('| **Candidate SHA** | `sha-commit-106` |');
      expect(refreshedPr.body).not.toContain('| **Candidate SHA** | `sha-commit-105` |');
      expect(refreshedPr.body).toContain('Closes #106');
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
      fakeGit.defaultMergeHead = integratedSha;
      fakeGit.ancestorResults.set(`${driftedSourceSha}|${integratedSha}`, true);
      fakeGit.treeShaResults.set(integratedSha, 'tree-integrated');

      const integrated = await coordinator.integrateSourceBranch(batchId);
      expect(integrated.success).toBe(true);
      if (integrated.success && integrated.outcome === 'merged') {
        expect(integrated.outcome).toBe('merged');
        expect(integrated.sourceBranch).toBe('main');
        expect(integrated.releaseBranch).toBe('release/2026-09-11-batch-five');
        expect(integrated.newReleaseSha).toBe(integratedSha);
      }

      expect(fakeGit.createWorktreeCalls).toHaveLength(1);
      expect(fakeGit.createWorktreeCalls[0]?.branch).toBe('release/2026-09-11-batch-five');
      expect(fakeGit.createWorktreeCalls[0]?.worktreePath).toContain('.ai-worktrees');
      expect(fakeGit.mergeBranchCalls).toHaveLength(1);
      expect(fakeGit.mergeBranchCalls[0]?.sourceRef).toBe('origin/main');
      expect(fakeGit.removeWorktreeCalls).toHaveLength(1);

      const saved = releaseBatchRepository.findById(batchId)!;
      expect(saved.status).toBe('awaiting_manual_test');
      expect(saved.candidateSha).toBe(integratedSha);
      expect(saved.candidateTreeSha).toBe('tree-integrated');

      const driftIntegratedEvent = eventBus.published.find(
        (p) => p.event.type === 'release_batch.source_drift_integrated',
      );
      expect(driftIntegratedEvent).toBeDefined();
      expect(driftIntegratedEvent?.runUuid).toBe(saved.items[4]?.runUuid);
      expect(driftIntegratedEvent?.runUuid).not.toBe(batchId);
    });

    it('integrateSourceBranch returns already_integrated when source branch is already contained in release branch', async () => {
      const { batchId } = setupFiveItemBatch();
      const finalSha = 'sha-commit-105';
      const containedSourceSha = 'sha-main-ancestor';
      fakeGit.remoteRefs.set('origin/release/2026-09-11-batch-five', finalSha);
      fakeGit.remoteRefs.set('origin/main', containedSourceSha);
      fakeGit.ancestorResults.set(`${containedSourceSha}|${finalSha}`, true);

      // Batch is blocked on source_branch_advanced
      let batch = releaseBatchRepository.findById(batchId)!;
      batch = { ...batch, status: 'blocked', blockedReason: 'source_branch_advanced' };
      releaseBatchRepository.update(batch);

      fakeGit.createWorktreeCalls = [];
      fakeGit.mergeBranchCalls = [];
      fakeGit.pushes = [];
      eventBus.published = [];

      const result = await coordinator.integrateSourceBranch(batchId);
      expect(result.success).toBe(true);
      if (result.success && result.outcome === 'already_integrated') {
        expect(result.outcome).toBe('already_integrated');
        expect(result.sourceBranch).toBe('main');
        expect(result.releaseBranch).toBe('release/2026-09-11-batch-five');
        expect(result.releaseSha).toBe(finalSha);
        expect((result as Record<string, unknown>)['newReleaseSha']).toBeUndefined();
      }

      // Assert no worktree, merge, or push was performed
      expect(fakeGit.createWorktreeCalls).toHaveLength(0);
      expect(fakeGit.mergeBranchCalls).toHaveLength(0);
      expect(fakeGit.pushes).toHaveLength(0);

      // Assert no integration event was published
      const driftIntegratedEvent = eventBus.published.find(
        (p) => p.event.type === 'release_batch.source_drift_integrated',
      );
      expect(driftIntegratedEvent).toBeUndefined();

      // Assert batch was unblocked
      const saved = releaseBatchRepository.findById(batchId)!;
      expect(saved.status).not.toBe('blocked');
    });

    it('integrateSourceBranch prevents false success when remote release ref does not advance after push', async () => {
      const { batchId } = setupFiveItemBatch();
      const releaseSha = 'sha-commit-105';
      const driftedSourceSha = 'sha-main-drifted-999';
      fakeGit.remoteRefs.set('origin/release/2026-09-11-batch-five', releaseSha);
      fakeGit.remoteRefs.set('origin/main', driftedSourceSha);
      fakeGit.ancestorResults.set(`${driftedSourceSha}|${releaseSha}`, false);

      // Model push that fails to advance remote release SHA
      fakeGit.headByCwd.set(defaultRepo.localBasePath, releaseSha);
      fakeGit.autoAdvanceOnMerge = false;
      fakeGit.push = vi.fn().mockResolvedValue(undefined);

      eventBus.published = [];
      fakeGit.createWorktreeCalls = [];
      fakeGit.removeWorktreeCalls = [];

      const result = await coordinator.integrateSourceBranch(batchId);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Remote release branch head did not advance after push');

      // Assert cleanup occurred
      expect(fakeGit.removeWorktreeCalls).toHaveLength(1);

      // Assert no integration event was published
      const driftIntegratedEvent = eventBus.published.find(
        (p) => p.event.type === 'release_batch.source_drift_integrated',
      );
      expect(driftIntegratedEvent).toBeUndefined();
    });

    it('integrateSourceBranch prevents false success when post-push ancestry check fails', async () => {
      const { batchId } = setupFiveItemBatch();
      const releaseSha = 'sha-commit-105';
      const driftedSourceSha = 'sha-main-drifted-999';
      const advancedSha = 'sha-commit-advanced-999';
      fakeGit.remoteRefs.set('origin/release/2026-09-11-batch-five', releaseSha);
      fakeGit.remoteRefs.set('origin/main', driftedSourceSha);
      fakeGit.ancestorResults.set(`${driftedSourceSha}|${releaseSha}`, false);

      // Worktree advances to advancedSha
      fakeGit.defaultMergeHead = advancedSha;
      fakeGit.push = vi.fn(async () => {
        fakeGit.remoteRefs.set('origin/release/2026-09-11-batch-five', advancedSha);
        fakeGit.resolveRefResults.set('origin/release/2026-09-11-batch-five', advancedSha);
      });
      // But ancestry check fails
      fakeGit.ancestorResults.set(`${driftedSourceSha}|${advancedSha}`, false);

      eventBus.published = [];
      fakeGit.removeWorktreeCalls = [];

      const result = await coordinator.integrateSourceBranch(batchId);
      expect(result.success).toBe(false);
      expect(result.error).toContain('is not an ancestor of updated release head');

      // Worktree must be cleaned up
      expect(fakeGit.removeWorktreeCalls).toHaveLength(1);

      // No event published
      const driftIntegratedEvent = eventBus.published.find(
        (p) => p.event.type === 'release_batch.source_drift_integrated',
      );
      expect(driftIntegratedEvent).toBeUndefined();
    });

    it('integrateSourceBranch fails on merge conflict and cleans up worktree without push or event', async () => {
      const { batchId } = setupFiveItemBatch();
      const releaseSha = 'sha-commit-105';
      const driftedSourceSha = 'sha-main-drifted-999';
      fakeGit.remoteRefs.set('origin/release/2026-09-11-batch-five', releaseSha);
      fakeGit.remoteRefs.set('origin/main', driftedSourceSha);
      fakeGit.ancestorResults.set(`${driftedSourceSha}|${releaseSha}`, false);

      fakeGit.mergeBranchResults.set('origin/main', {
        success: false,
        conflict: true,
        error: 'Automatic merge failed; fix conflicts and then commit the result.',
      });

      fakeGit.pushes = [];
      eventBus.published = [];
      fakeGit.removeWorktreeCalls = [];

      const result = await coordinator.integrateSourceBranch(batchId);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Automatic merge failed');

      // Worktree was removed
      expect(fakeGit.removeWorktreeCalls).toHaveLength(1);
      // No push was executed
      expect(fakeGit.pushes).toHaveLength(0);
      // No event was published
      const driftIntegratedEvent = eventBus.published.find(
        (p) => p.event.type === 'release_batch.source_drift_integrated',
      );
      expect(driftIntegratedEvent).toBeUndefined();
    });

    it('integrateSourceBranch fails when worktree branch mismatches batch release branch', async () => {
      const { batchId } = setupFiveItemBatch();
      const releaseSha = 'sha-commit-105';
      const driftedSourceSha = 'sha-main-drifted-999';
      fakeGit.remoteRefs.set('origin/release/2026-09-11-batch-five', releaseSha);
      fakeGit.remoteRefs.set('origin/main', driftedSourceSha);
      fakeGit.ancestorResults.set(`${driftedSourceSha}|${releaseSha}`, false);

      // Return a mismatched branch
      const origCurrentBranch = fakeGit.currentBranch.bind(fakeGit);
      fakeGit.currentBranch = vi.fn().mockResolvedValue('wrong-branch');

      fakeGit.removeWorktreeCalls = [];
      const result = await coordinator.integrateSourceBranch(batchId);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Worktree branch mismatch');
      expect(fakeGit.removeWorktreeCalls).toHaveLength(1);

      fakeGit.currentBranch = origCurrentBranch;
    });

    it('integrateSourceBranch fails when worktree cleanup fails after push', async () => {
      const { batchId } = setupFiveItemBatch();
      const releaseSha = 'sha-commit-105';
      const driftedSourceSha = 'sha-main-drifted-999';
      const integratedSha = 'sha-integrated-cleanup-fail';
      fakeGit.remoteRefs.set('origin/release/2026-09-11-batch-five', releaseSha);
      fakeGit.remoteRefs.set('origin/main', driftedSourceSha);
      fakeGit.ancestorResults.set(`${driftedSourceSha}|${releaseSha}`, false);
      fakeGit.defaultMergeHead = integratedSha;
      fakeGit.ancestorResults.set(`${driftedSourceSha}|${integratedSha}`, true);

      fakeGit.removeWorktree = vi
        .fn()
        .mockRejectedValue(new Error('EPERM: operation not permitted'));

      eventBus.published = [];
      const result = await coordinator.integrateSourceBranch(batchId);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to remove worktree');

      // Invariant: integration event must NOT be published if cleanup invariant fails
      const driftIntegratedEvent = eventBus.published.find(
        (p) => p.event.type === 'release_batch.source_drift_integrated',
      );
      expect(driftIntegratedEvent).toBeUndefined();
    });

    it('integrateSourceBranch tolerates already absent worktree path during cleanup', async () => {
      const { batchId } = setupFiveItemBatch();
      const releaseSha = 'sha-commit-105';
      const driftedSourceSha = 'sha-main-drifted-999';
      const integratedSha = 'sha-integrated-absent-ok';
      fakeGit.remoteRefs.set('origin/release/2026-09-11-batch-five', releaseSha);
      fakeGit.remoteRefs.set('origin/main', driftedSourceSha);
      fakeGit.ancestorResults.set(`${driftedSourceSha}|${releaseSha}`, false);
      fakeGit.defaultMergeHead = integratedSha;
      fakeGit.ancestorResults.set(`${driftedSourceSha}|${integratedSha}`, true);

      // Simulate removeWorktree throwing 'no worktree ...' because already removed
      fakeGit.removeWorktree = vi
        .fn()
        .mockRejectedValue(new Error('no worktree /path/to/worktree'));

      const result = await coordinator.integrateSourceBranch(batchId);
      expect(result.success).toBe(true);
      if (result.success && result.outcome === 'merged') {
        expect(result.outcome).toBe('merged');
        expect(result.newReleaseSha).toBe(integratedSha);
      }
    });

    it('integrateSourceBranch evaluates fresh remote-tracking refs, ignoring stale local branch refs', async () => {
      const { batchId } = setupFiveItemBatch();
      const staleLocalReleaseSha = 'sha-local-stale-release';
      const freshRemoteReleaseSha = 'sha-remote-fresh-release';
      const freshRemoteSourceSha = 'sha-remote-fresh-source';
      const staleLocalSourceSha = 'sha-local-stale-source';

      // Local branches have stale refs
      fakeGit.resolveRefResults.set('release/2026-09-11-batch-five', staleLocalReleaseSha);
      fakeGit.resolveRefResults.set('main', staleLocalSourceSha);

      // Remote tracking refs have fresh refs
      fakeGit.remoteRefs.set('origin/release/2026-09-11-batch-five', freshRemoteReleaseSha);
      fakeGit.remoteRefs.set('origin/main', freshRemoteSourceSha);

      // Fresh remote source IS contained by fresh remote release
      fakeGit.ancestorResults.set(`${freshRemoteSourceSha}|${freshRemoteReleaseSha}`, true);
      // Stale local source is NOT contained
      fakeGit.ancestorResults.set(`${staleLocalSourceSha}|${staleLocalReleaseSha}`, false);

      const result = await coordinator.integrateSourceBranch(batchId);
      expect(result.success).toBe(true);
      if (result.success && result.outcome === 'already_integrated') {
        expect(result.outcome).toBe('already_integrated');
        expect(result.releaseSha).toBe(freshRemoteReleaseSha);
      }
    });

    it('integrateSourceBranch fails when source branch advances during merge/push and refetches fresh source tip', async () => {
      const { batchId } = setupFiveItemBatch();
      const initialReleaseSha = 'sha-commit-105';
      const initialSourceSha = 'sha-main-drifted-999';
      const mergedReleaseSha = 'sha-commit-integrated-merge';
      const racingSourceSha = 'sha-main-racing-drift-1000';

      fakeGit.remoteRefs.set('origin/release/2026-09-11-batch-five', initialReleaseSha);
      fakeGit.remoteRefs.set('origin/main', initialSourceSha);
      fakeGit.ancestorResults.set(`${initialSourceSha}|${initialReleaseSha}`, false);

      fakeGit.defaultMergeHead = mergedReleaseSha;

      // During push, origin/main races ahead
      fakeGit.push = vi.fn(async () => {
        fakeGit.remoteRefs.set('origin/release/2026-09-11-batch-five', mergedReleaseSha);
        fakeGit.resolveRefResults.set('origin/release/2026-09-11-batch-five', mergedReleaseSha);
        fakeGit.remoteRefs.set('origin/main', racingSourceSha);
        fakeGit.resolveRefResults.set('origin/main', racingSourceSha);
      });

      // Ancestry from initial source to merged release would be true, but racing source is NOT an ancestor
      fakeGit.ancestorResults.set(`${initialSourceSha}|${mergedReleaseSha}`, true);
      fakeGit.ancestorResults.set(`${racingSourceSha}|${mergedReleaseSha}`, false);

      eventBus.published = [];
      fakeGit.removeWorktreeCalls = [];

      const result = await coordinator.integrateSourceBranch(batchId);
      expect(result.success).toBe(false);
      expect(result.error).toContain('is not an ancestor of updated release head');

      // Assert cleanup occurred
      expect(fakeGit.removeWorktreeCalls).toHaveLength(1);

      // Assert no integration event was published
      const driftIntegratedEvent = eventBus.published.find(
        (p) => p.event.type === 'release_batch.source_drift_integrated',
      );
      expect(driftIntegratedEvent).toBeUndefined();
    });

    it('integrateSourceBranch confines worktree path under .ai-worktrees when batch ID contains path traversal', async () => {
      const traversalBatchId = ReleaseBatchId('../../traversal-batch');
      const batch = createReleaseBatch({
        id: traversalBatchId,
        repoId: RepositoryId('test-org/test-repo'),
        sourceBranch: 'main',
        sourceStartSha: 'start-sha',
        releaseBranch: 'release/traversal-batch',
        createdAt: t1,
        items: [
          {
            position: 1,
            issueNumber: 1,
            runUuid: '550e8400-e29b-41d4-a716-446655440000',
            status: 'merged',
          },
        ],
      });
      releaseBatchRepository.insert(batch);

      const releaseSha = 'sha-commit-105';
      const driftedSourceSha = 'sha-main-drifted-999';
      fakeGit.remoteRefs.set('origin/release/traversal-batch', releaseSha);
      fakeGit.remoteRefs.set('origin/main', driftedSourceSha);
      fakeGit.ancestorResults.set(`${driftedSourceSha}|${releaseSha}`, false);

      const integratedSha = 'sha-commit-integrated-merge';
      fakeGit.defaultMergeHead = integratedSha;
      fakeGit.ancestorResults.set(`${driftedSourceSha}|${integratedSha}`, true);

      fakeGit.createWorktreeCalls = [];
      fakeGit.currentBranchByCwd.clear();

      // Ensure currentBranch returns release branch for any worktree path
      const originalCurrentBranch = fakeGit.currentBranch.bind(fakeGit);
      fakeGit.currentBranch = vi.fn().mockImplementation(async (cwd: string) => {
        if (cwd.includes('.ai-worktrees')) return 'release/traversal-batch';
        return originalCurrentBranch(cwd);
      });

      const result = await coordinator.integrateSourceBranch(traversalBatchId);
      expect(result.success).toBe(true);

      expect(fakeGit.createWorktreeCalls).toHaveLength(1);
      const createdPath = fakeGit.createWorktreeCalls[0]!.worktreePath;
      const worktreesRoot = path.resolve(defaultRepo.localBasePath, '.ai-worktrees');
      const rel = path.relative(worktreesRoot, createdPath);
      expect(rel.startsWith('..')).toBe(false);
      expect(path.isAbsolute(rel)).toBe(false);
      expect(createdPath.startsWith(worktreesRoot)).toBe(true);
    });

    it('reconcile allows source branch advancement when commit matches approved promotion PR and persists promotionCommitSha', async () => {
      const { batchId } = setupFiveItemBatch();
      const candidateSha = 'sha-candidate-456';
      const promotionSha = 'sha-promoted-commit-789';

      let batch = releaseBatchRepository.findById(batchId)!;
      for (const item of batch.items) {
        item.status = 'merged';
        item.mergedCommitSha = 'sha-item-' + item.position;
      }
      batch.candidateSha = candidateSha;
      batch.approvedCandidateSha = candidateSha;
      batch.candidateTreeSha = 'tree-candidate-456';
      batch.status = 'approved';
      batch.promotionPrNumber = 42;
      batch.promotionCommitSha = undefined;
      releaseBatchRepository.update(batch);

      // GitHub reports PR is merged with mergeCommitSha
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

      // Remote source branch advanced to the promotion merge commit
      fakeGit.remoteRefs.set('origin/' + batch.sourceBranch, promotionSha);
      fakeGit.remoteRefs.set('origin/' + batch.releaseBranch, candidateSha);
      fakeGit.ancestorResults.set(`${promotionSha}|${candidateSha}`, false);

      const result = await coordinator.reconcile(batchId);
      expect(result.actions).not.toContain('blocked');
      expect(result.actions).not.toContain('approval_invalidated');
      expect(result.actions).not.toContain('source_drift_detected');
      expect(result.batchStatus).toBe('approved');

      // Batch now has promotionCommitSha persisted
      const saved = releaseBatchRepository.findById(batchId)!;
      expect(saved.promotionCommitSha).toBe(promotionSha);
      expect(saved.status).toBe('approved');

      // Now source branch advances further to new drift
      const laterDriftSha = 'sha-main-later-drift-999';
      fakeGit.remoteRefs.set('origin/' + batch.sourceBranch, laterDriftSha);
      fakeGit.ancestorResults.set(`${laterDriftSha}|${candidateSha}`, false);

      const resultAfterDrift = await coordinator.reconcile(batchId);
      expect(resultAfterDrift.actions).toContain('blocked');
      expect(resultAfterDrift.actions).toContain('approval_invalidated');
      expect(resultAfterDrift.actions).toContain('source_drift_detected');
      expect(resultAfterDrift.batchStatus).toBe('blocked');

      const savedBlocked = releaseBatchRepository.findById(batchId)!;
      expect(savedBlocked.status).toBe('blocked');
      expect(savedBlocked.blockedReason).toBe('source_branch_advanced');
    });

    it('reconcile handles merged promotion PR without mergeCommitSha by using resolved remote source tip', async () => {
      const { batchId } = setupFiveItemBatch();
      const candidateSha = 'sha-candidate-456';
      const resolvedSourceTip = 'sha-source-tip-888';

      let batch = releaseBatchRepository.findById(batchId)!;
      for (const item of batch.items) {
        item.status = 'merged';
        item.mergedCommitSha = 'sha-item-' + item.position;
      }
      batch.candidateSha = candidateSha;
      batch.approvedCandidateSha = candidateSha;
      batch.candidateTreeSha = 'tree-candidate-456';
      batch.status = 'approved';
      batch.promotionPrNumber = 43;
      batch.promotionCommitSha = undefined;
      releaseBatchRepository.update(batch);

      // GitHub reports PR is merged without mergeCommitSha
      fakeGitHub.mergeReadiness.set('test-org/test-repo/43', {
        prNumber: 43,
        state: 'merged',
        isMerged: true,
        ciStatus: 'passed',
        mergeStateStatus: 'clean',
        baseRefName: batch.sourceBranch,
        autoMergeEnabled: true,
      });

      fakeGit.remoteRefs.set('origin/' + batch.sourceBranch, resolvedSourceTip);
      fakeGit.remoteRefs.set('origin/' + batch.releaseBranch, candidateSha);
      fakeGit.ancestorResults.set(`${resolvedSourceTip}|${candidateSha}`, false);

      const result = await coordinator.reconcile(batchId);
      expect(result.actions).not.toContain('blocked');
      expect(result.actions).not.toContain('approval_invalidated');
      expect(result.batchStatus).toBe('approved');

      const saved = releaseBatchRepository.findById(batchId)!;
      expect(saved.promotionCommitSha).toBe(resolvedSourceTip);
    });

    it('reconcile blocks with source_branch_advanced when PR readiness reports unmerged even if stale promotionCommitSha matches source tip', async () => {
      const { batchId } = setupFiveItemBatch();
      const candidateSha = 'sha-candidate-456';
      const stalePromotionSha = 'sha-stale-promoted-789';

      let batch = releaseBatchRepository.findById(batchId)!;
      for (const item of batch.items) {
        item.status = 'merged';
        item.mergedCommitSha = 'sha-item-' + item.position;
      }
      batch.candidateSha = candidateSha;
      batch.approvedCandidateSha = candidateSha;
      batch.candidateTreeSha = 'tree-candidate-456';
      batch.status = 'approved';
      batch.promotionPrNumber = 44;
      batch.promotionCommitSha = stalePromotionSha;
      releaseBatchRepository.update(batch);

      // GitHub reports PR is NOT merged (e.g. open or draft)
      fakeGitHub.mergeReadiness.set('test-org/test-repo/44', {
        prNumber: 44,
        state: 'open',
        isMerged: false,
        ciStatus: 'passed',
        mergeStateStatus: 'clean',
        baseRefName: batch.sourceBranch,
        autoMergeEnabled: false,
      });

      // Remote source matches the stale promotionCommitSha, but PR is not merged
      fakeGit.remoteRefs.set('origin/' + batch.sourceBranch, stalePromotionSha);
      fakeGit.remoteRefs.set('origin/' + batch.releaseBranch, candidateSha);
      fakeGit.ancestorResults.set(`${stalePromotionSha}|${candidateSha}`, false);

      const result = await coordinator.reconcile(batchId);
      expect(result.actions).toContain('blocked');
      expect(result.actions).toContain('approval_invalidated');
      expect(result.actions).toContain('source_drift_detected');
      expect(result.batchStatus).toBe('blocked');

      const savedBlocked = releaseBatchRepository.findById(batchId)!;
      expect(savedBlocked.status).toBe('blocked');
      expect(savedBlocked.blockedReason).toBe('source_branch_advanced');
    });

    it('reconcile blocks with source_branch_advanced when PR readiness lookup fails even if stale promotionCommitSha matches source tip', async () => {
      const { batchId } = setupFiveItemBatch();
      const candidateSha = 'sha-candidate-456';
      const stalePromotionSha = 'sha-stale-promoted-789';

      let batch = releaseBatchRepository.findById(batchId)!;
      for (const item of batch.items) {
        item.status = 'merged';
        item.mergedCommitSha = 'sha-item-' + item.position;
      }
      batch.candidateSha = candidateSha;
      batch.approvedCandidateSha = candidateSha;
      batch.candidateTreeSha = 'tree-candidate-456';
      batch.status = 'approved';
      batch.promotionPrNumber = 45;
      batch.promotionCommitSha = stalePromotionSha;
      releaseBatchRepository.update(batch);

      // GitHub throws an error (e.g. network failure)
      fakeGitHub.getPrMergeReadiness = vi
        .fn()
        .mockRejectedValue(new Error('GitHub API unavailable'));

      // Remote source matches the stale promotionCommitSha
      fakeGit.remoteRefs.set('origin/' + batch.sourceBranch, stalePromotionSha);
      fakeGit.remoteRefs.set('origin/' + batch.releaseBranch, candidateSha);
      fakeGit.ancestorResults.set(`${stalePromotionSha}|${candidateSha}`, false);

      const result = await coordinator.reconcile(batchId);
      expect(result.actions).toContain('blocked');
      expect(result.actions).toContain('approval_invalidated');
      expect(result.actions).toContain('source_drift_detected');
      expect(result.batchStatus).toBe('blocked');

      const savedBlocked = releaseBatchRepository.findById(batchId)!;
      expect(savedBlocked.status).toBe('blocked');
      expect(savedBlocked.blockedReason).toBe('source_branch_advanced');
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

      const completedEvent = eventBus.published.find(
        (p) => p.event.type === 'release_batch.completed',
      );
      expect(completedEvent).toBeDefined();
      expect(completedEvent?.runUuid).toBe(saved.items[0]?.runUuid);
      expect(completedEvent?.runUuid).not.toBe(batchId);
    });

    it('publishes batch-level events with fallback runUuid from latest item and avoids batch.id as runUuid (#1266)', async () => {
      const { batchId } = setupFiveItemBatch();
      const insertedEvents: Array<{ runUuid: string; type: string }> = [];
      const fakeEventRepo = {
        insert: vi.fn((ev: { runUuid: string; type: string }) => {
          insertedEvents.push(ev);
          return 1;
        }),
        listByRunSince: vi.fn(() => []),
      };

      const customCoordinator = new ReleaseBatchCoordinator({
        releaseBatchRepository,
        runRepository,
        repositoryPort,
        jobQueue,
        eventBus,
        eventRepository: fakeEventRepo,
        git: fakeGit,
        github: fakeGitHub,
        now: () => t1,
      });

      // Prepare git refs for integrateSourceBranch
      const driftedSourceSha = 'sha-drifted';
      const finalSha = 'sha-commit-105';
      const integratedSha = 'sha-integrated';
      fakeGit.remoteRefs.set('origin/release/2026-09-11-batch-five', finalSha);
      fakeGit.remoteRefs.set('origin/main', driftedSourceSha);
      fakeGit.ancestorResults.set(`${driftedSourceSha}|${finalSha}`, false);
      fakeGit.defaultMergeHead = integratedSha;
      fakeGit.treeShaResults.set(integratedSha, 'tree-integrated');

      for (let pos = 1; pos <= 5; pos++) {
        await customCoordinator.certifyItemMerged({
          batchId,
          position: pos,
          mergedCommitSha: `sha-commit-${100 + pos}`,
          now: t1,
        });
      }

      eventBus.published = [];
      insertedEvents.length = 0;

      const res = await customCoordinator.integrateSourceBranch(batchId);
      expect(res.success).toBe(true);

      const saved = releaseBatchRepository.findById(batchId)!;
      const expectedItemRunUuid = saved.items[4]?.runUuid;
      expect(expectedItemRunUuid).toBeDefined();

      // Verify all published events have valid runUuid (matching item 5), none have batchId
      expect(eventBus.published.length).toBeGreaterThan(0);
      for (const { runUuid } of eventBus.published) {
        expect(runUuid).toBe(expectedItemRunUuid);
        expect(runUuid).not.toBe(batchId);
      }

      // Verify eventRepo.insert was called with expectedItemRunUuid, never batchId
      expect(insertedEvents.length).toBeGreaterThan(0);
      for (const { runUuid } of insertedEvents) {
        expect(runUuid).toBe(expectedItemRunUuid);
        expect(runUuid).not.toBe(batchId);
      }
    });
  });

  describe('successor base SHA safety and git failure handling (#1224)', () => {
    it('blocks batch with base_sha_unresolvable if git.fetch fails during successor admission', async () => {
      const fakeGit = new FakeGitPort();
      fakeGit.fetch = vi.fn().mockRejectedValue(new Error('network connection timed out'));
      const coordWithGit = new ReleaseBatchCoordinator({
        releaseBatchRepository,
        runRepository,
        repositoryPort,
        jobQueue,
        eventBus,
        git: fakeGit,
      });

      const { batchId } = setupFiveItemBatch();

      // Certify item 1 merged
      const batch = releaseBatchRepository.findById(batchId)!;
      const updated = markItemMerged(batch, 1, { mergedCommitSha: 'sha-m1', now: t2 });
      releaseBatchRepository.update(updated);

      // Reconcile item 2 admission
      const result = await coordWithGit.reconcile(batchId);
      expect(result.batchStatus).toBe('blocked');
      expect(result.actions).toContain('blocked');

      const saved = releaseBatchRepository.findById(batchId)!;
      expect(saved.status).toBe('blocked');
      expect(saved.blockedReason).toContain('base_sha_unresolvable');
      expect(saved.blockedReason).toContain('network connection timed out');

      // Item 2 was NOT admitted
      expect(saved.items[1]?.status).toBe('pending');
      expect(saved.items[1]?.runUuid).toBeUndefined();

      // Event was emitted
      const blockedEvent = eventBus.published.find(
        (p) => p.event.type === 'release_batch.blocked' && p.event.metadata?.position === 2,
      );
      expect(blockedEvent).toBeDefined();
    });

    it('blocks batch with base_sha_unresolvable when prior item has no mergedCommitSha and git is unavailable', async () => {
      const { batchId } = setupFiveItemBatch();

      // Manually set item 1 to merged without mergedCommitSha (e.g. database anomaly or legacy record)
      const batch = releaseBatchRepository.findById(batchId)!;
      const items = [...batch.items];
      items[0] = { ...items[0]!, status: 'merged', mergedCommitSha: undefined };
      releaseBatchRepository.update({ ...batch, items });

      const result = await coordinator.reconcile(batchId);
      expect(result.batchStatus).toBe('blocked');
      expect(result.actions).toContain('blocked');

      const saved = releaseBatchRepository.findById(batchId)!;
      expect(saved.status).toBe('blocked');
      expect(saved.blockedReason).toContain('base_sha_unresolvable');
      expect(saved.blockedReason).toContain('no mergedCommitSha');

      // Item 2 was NOT admitted
      expect(saved.items[1]?.status).toBe('pending');
      expect(saved.items[1]?.runUuid).toBeUndefined();
    });

    it('automatically unblocks from base_sha_unresolvable once git resolves successfully', async () => {
      const fakeGit = new FakeGitPort();
      fakeGit.fetch = vi.fn().mockRejectedValueOnce(new Error('temporary git lock'));
      const coordWithGit = new ReleaseBatchCoordinator({
        releaseBatchRepository,
        runRepository,
        repositoryPort,
        jobQueue,
        eventBus,
        git: fakeGit,
      });

      const { batchId } = setupFiveItemBatch();
      const batch = releaseBatchRepository.findById(batchId)!;
      const updated = markItemMerged(batch, 1, { mergedCommitSha: 'sha-m1', now: t2 });
      releaseBatchRepository.update(updated);

      // 1. First reconcile fails due to git error and blocks
      const res1 = await coordWithGit.reconcile(batchId);
      expect(res1.batchStatus).toBe('blocked');
      expect(res1.batch.blockedReason).toContain('temporary git lock');

      // 2. Fix git fetch and set remote ref
      fakeGit.fetch = vi.fn().mockResolvedValue(undefined);
      fakeGit.remoteRefs.set(`origin/${batch.releaseBranch}`, 'sha-remote-item-1-tip');

      // 3. Next reconcile unblocks and admits successor with fresh remote SHA
      const res2 = await coordWithGit.reconcile(batchId);
      expect(res2.actions).toContain('unblocked');
      expect(res2.actions).toContain('successor_admitted');
      expect(res2.batchStatus).toBe('building');

      const saved = releaseBatchRepository.findById(batchId)!;
      expect(saved.status).toBe('building');
      expect(saved.blockedReason).toBeUndefined();
      expect(saved.items[1]?.status).toBe('active');
      expect(saved.items[1]?.baseSha).toBe('sha-remote-item-1-tip');

      const run2 = runRepository.findByUuid(saved.items[1]?.runUuid!);
      expect(run2?.startCommitSha).toBe('sha-remote-item-1-tip');
    });

    it('throws ReleaseBatchStateError if admitSuccessor is called with sourceStartSha for position > 1', async () => {
      const { batchId } = setupFiveItemBatch();
      const batch = releaseBatchRepository.findById(batchId)!;

      // Access private admitSuccessor for direct assertion
      const admitSuccessorFn = (
        coordinator as unknown as {
          admitSuccessor: (
            batch: typeof batch,
            item: (typeof batch.items)[number],
            now: Date,
            baseSha?: string,
          ) => Promise<void>;
        }
      ).admitSuccessor.bind(coordinator);
      await expect(
        admitSuccessorFn(batch, batch.items[1], new Date(), batch.sourceStartSha),
      ).rejects.toThrow(ReleaseBatchStateError);
    });
  });

  describe('Runtime pin inheritance', () => {
    it('inherits pinnedRuntime from prior item when admitting successor', async () => {
      const { batchId } = setupFiveItemBatch();
      const initialRun = runRepository.findByUuid('run-item-1')!;
      runRepository.runs.set('run-item-1', {
        ...initialRun,
        pinnedRuntime: 'claude-code',
      });

      const result = await coordinator.certifyItemMerged({
        batchId,
        position: 1,
        mergedCommitSha: 'sha-commit-101',
        now: t2,
      });

      expect(result.actions).toContain('successor_admitted');
      const saved = releaseBatchRepository.findById(batchId)!;
      const run2 = runRepository.findByUuid(saved.items[1]?.runUuid!);
      expect(run2?.pinnedRuntime).toBe('claude-code');
    });

    it('inherits pinnedRuntime from deps fallback when prior item has no pinnedRuntime', async () => {
      const coordinatorWithPin = new ReleaseBatchCoordinator({
        releaseBatchRepository,
        runRepository,
        jobQueue,
        repositoryPort,
        eventBus,
        now: () => t1,
        pinnedRuntime: 'codex',
      });

      const { batchId } = setupFiveItemBatch();
      const result = await coordinatorWithPin.certifyItemMerged({
        batchId,
        position: 1,
        mergedCommitSha: 'sha-commit-101',
        now: t2,
      });

      expect(result.actions).toContain('successor_admitted');
      const saved = releaseBatchRepository.findById(batchId)!;
      const run2 = runRepository.findByUuid(saved.items[1]?.runUuid!);
      expect(run2?.pinnedRuntime).toBe('codex');
    });

    it('leaves pinnedRuntime undefined when neither prior item nor deps specify one', async () => {
      const { batchId } = setupFiveItemBatch();
      const result = await coordinator.certifyItemMerged({
        batchId,
        position: 1,
        mergedCommitSha: 'sha-commit-101',
        now: t2,
      });

      expect(result.actions).toContain('successor_admitted');
      const saved = releaseBatchRepository.findById(batchId)!;
      const run2 = runRepository.findByUuid(saved.items[1]?.runUuid!);
      expect(run2?.pinnedRuntime).toBeUndefined();
    });
  });
});
