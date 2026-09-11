import { describe, it, expect, beforeEach } from 'vitest';
import {
  RepositoryId,
  ReleaseBatchId,
  createReleaseBatch,
  admitItem,
  markItemMerged,
  type Repository,
  SourceBranchDriftError,
  ReleaseBranchDriftError,
  RemediationNotAllowedError,
} from '@ai-sdlc/domain';
import {
  ApproveReleaseBatchCandidate,
  RejectReleaseBatchCandidate,
  AppendRemediationIssues,
  PromoteReleaseBatch,
} from '../manual-test-gate.js';
import type { ReleaseBatchCoordinator } from '../release-batch-coordinator.js';
import { FakeReleaseBatchRepository } from '../test-doubles/fake-release-batch-repository.js';
import { FakeGitPort } from '../test-doubles/fake-git-port.js';
import { FakeGitHubPort } from '../test-doubles/fake-github-port.js';
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

describe('ManualTestGate use cases', () => {
  let defaultRepo: Repository;
  let repoPort: FakeRepositoryPort;
  let batchRepo: FakeReleaseBatchRepository;
  let git: FakeGitPort;
  let github: FakeGitHubPort;
  const now = () => new Date('2026-09-11T14:00:00.000Z');

  beforeEach(() => {
    defaultRepo = createTestRepo();
    repoPort = new FakeRepositoryPort([defaultRepo]);
    batchRepo = new FakeReleaseBatchRepository();
    git = new FakeGitPort();
    github = new FakeGitHubPort();
  });

  function setupAwaitingBatch(candidateSha = 'sha-cand-123') {
    const batchId = ReleaseBatchId('batch-gate-001');
    let batch = createReleaseBatch({
      id: batchId,
      repoId: defaultRepo.id,
      sourceBranch: 'main',
      sourceStartSha: 'sha-main-001',
      releaseBranch: 'release/2026-09-11-cand',
      items: [{ position: 1, issueNumber: 101 }],
      createdAt: new Date('2026-09-11T12:00:00.000Z'),
    });

    batch = admitItem(batch, 1, {
      runUuid: 'run-001',
      baseSha: 'sha-main-001',
      now: new Date('2026-09-11T12:01:00.000Z'),
    });

    batch = markItemMerged(batch, 1, {
      mergedCommitSha: candidateSha,
      now: new Date('2026-09-11T12:05:00.000Z'),
    });

    // Directly set candidate on batch and status to awaiting_manual_test
    batch = {
      ...batch,
      status: 'awaiting_manual_test',
      candidateSha,
      candidateTreeSha: 'tree-' + candidateSha,
    };
    batchRepo.insert(batch);

    // Setup Git remote refs and ancestry
    git.remoteRefs.set('origin/release/2026-09-11-cand', candidateSha);
    git.remoteRefs.set('origin/main', 'sha-main-001');
    git.treeShaResults.set(candidateSha, 'tree-' + candidateSha);
    // main is ancestor of release branch
    git.ancestorResults.set(`sha-main-001|${candidateSha}`, true);

    return { batchId, candidateSha };
  }

  describe('ApproveReleaseBatchCandidate', () => {
    it('approves exact candidate SHA when git remote matches and source has not drifted', async () => {
      const { batchId, candidateSha } = setupAwaitingBatch();
      const approveUseCase = new ApproveReleaseBatchCandidate({
        releaseBatchRepository: batchRepo,
        repositoryPort: repoPort,
        git,
        now,
      });

      const updated = await approveUseCase.execute({
        batchId,
        candidateSha,
      });

      expect(updated.status).toBe('approved');
      expect(updated.candidateSha).toBe(candidateSha);

      const persisted = batchRepo.findById(batchId);
      expect(persisted?.status).toBe('approved');
    });

    it('rejects approval if candidateSha argument does not match batch candidateSha', async () => {
      const { batchId } = setupAwaitingBatch('sha-cand-123');
      const approveUseCase = new ApproveReleaseBatchCandidate({
        releaseBatchRepository: batchRepo,
        repositoryPort: repoPort,
        git,
        now,
      });

      await expect(
        approveUseCase.execute({
          batchId,
          candidateSha: 'sha-wrong-sha',
        }),
      ).rejects.toThrow(/does not match/i);
    });

    it('rejects approval if release branch moved on origin (release branch drift)', async () => {
      const { batchId, candidateSha } = setupAwaitingBatch('sha-cand-123');
      // Remote moved!
      git.remoteRefs.set('origin/release/2026-09-11-cand', 'sha-cand-moved');

      const approveUseCase = new ApproveReleaseBatchCandidate({
        releaseBatchRepository: batchRepo,
        repositoryPort: repoPort,
        git,
        now,
      });

      await expect(
        approveUseCase.execute({
          batchId,
          candidateSha,
        }),
      ).rejects.toThrow(ReleaseBranchDriftError);
    });

    it('rejects approval if source branch drifted and is not contained in release branch', async () => {
      const { batchId, candidateSha } = setupAwaitingBatch('sha-cand-123');
      // Origin main moved to new sha that is not an ancestor of candidateSha
      git.remoteRefs.set('origin/main', 'sha-main-drifted');
      // Not in ancestorPairs

      const approveUseCase = new ApproveReleaseBatchCandidate({
        releaseBatchRepository: batchRepo,
        repositoryPort: repoPort,
        git,
        now,
      });

      await expect(
        approveUseCase.execute({
          batchId,
          candidateSha,
        }),
      ).rejects.toThrow(SourceBranchDriftError);
    });

    it('rejects approval if batch is not in awaiting_manual_test status', async () => {
      const { batchId, candidateSha } = setupAwaitingBatch();
      const existing = batchRepo.findById(batchId)!;
      batchRepo.update({ ...existing, status: 'building' });

      const approveUseCase = new ApproveReleaseBatchCandidate({
        releaseBatchRepository: batchRepo,
        repositoryPort: repoPort,
        git,
        now,
      });

      await expect(
        approveUseCase.execute({
          batchId,
          candidateSha,
        }),
      ).rejects.toThrow(/cannot approve candidate/i);
    });
  });

  describe('RejectReleaseBatchCandidate', () => {
    it('transitions batch to test_failed and preserves candidateSha', async () => {
      const { batchId, candidateSha } = setupAwaitingBatch();
      const rejectUseCase = new RejectReleaseBatchCandidate({
        releaseBatchRepository: batchRepo,
        now,
      });

      const updated = await rejectUseCase.execute({
        batchId,
        candidateSha,
        reason: 'E2E manual test flaky login failed',
      });

      expect(updated.status).toBe('test_failed');
      expect(updated.candidateSha).toBe(candidateSha);
      expect(updated.blockedReason).toBe('E2E manual test flaky login failed');

      const persisted = batchRepo.findById(batchId);
      expect(persisted?.status).toBe('test_failed');
    });

    it('throws when candidateSha does not match', async () => {
      const { batchId } = setupAwaitingBatch('sha-cand-123');
      const rejectUseCase = new RejectReleaseBatchCandidate({
        releaseBatchRepository: batchRepo,
        now,
      });

      await expect(
        rejectUseCase.execute({
          batchId,
          candidateSha: 'sha-different',
        }),
      ).rejects.toThrow(/does not match/i);
    });

    it('throws if batch is not in awaiting_manual_test', async () => {
      const { batchId, candidateSha } = setupAwaitingBatch();
      const existing = batchRepo.findById(batchId)!;
      batchRepo.update({ ...existing, status: 'approved' });

      const rejectUseCase = new RejectReleaseBatchCandidate({
        releaseBatchRepository: batchRepo,
        now,
      });

      await expect(
        rejectUseCase.execute({
          batchId,
          candidateSha,
        }),
      ).rejects.toThrow(/cannot reject candidate/i);
    });
  });

  describe('AppendRemediationIssues', () => {
    it('appends issues when batch is test_failed and transitions back to building', async () => {
      const { batchId } = setupAwaitingBatch();
      // Set to test_failed
      const batch = batchRepo.findById(batchId)!;
      batchRepo.update({
        ...batch,
        status: 'test_failed',
        blockerReason: 'manual_test_failed',
      });

      // Setup issue 102 in fake github
      github.issues.set('test-org/test-repo/102', {
        number: 102,
        title: 'Fix login flaky test',
        state: 'open',
      });
      github.issues.set('test-org/test-repo/103', {
        number: 103,
        title: 'Fix auth cookie',
        state: 'open',
      });

      let reconciledBatchId: string | null = null;
      const fakeCoordinator = {
        reconcile: async (id: ReleaseBatchId) => {
          reconciledBatchId = String(id);
          return { batchId: id, actions: [] };
        },
      };

      const appendUseCase = new AppendRemediationIssues({
        releaseBatchRepository: batchRepo,
        repositoryPort: repoPort,
        github,
        coordinator: fakeCoordinator as unknown as ReleaseBatchCoordinator,
        now,
      });

      const updated = await appendUseCase.execute({
        batchId,
        issueNumbers: [102, 103],
      });

      expect(updated.status).toBe('building');
      expect(updated.candidateSha).toBeUndefined();
      expect(updated.candidateTreeSha).toBeUndefined();
      expect(updated.items).toHaveLength(3);
      expect(updated.items[1]).toMatchObject({
        position: 2,
        issueNumber: 102,
        status: 'pending',
      });
      expect(updated.items[2]).toMatchObject({
        position: 3,
        issueNumber: 103,
        status: 'pending',
      });
      expect(reconciledBatchId).toBe(String(batchId));
    });

    it('rejects appending if batch is NOT in test_failed state', async () => {
      const { batchId } = setupAwaitingBatch();
      // Batch is still awaiting_manual_test

      const appendUseCase = new AppendRemediationIssues({
        releaseBatchRepository: batchRepo,
        repositoryPort: repoPort,
        github,
        now,
      });

      await expect(
        appendUseCase.execute({
          batchId,
          issueNumbers: [102],
        }),
      ).rejects.toThrow(RemediationNotAllowedError);
    });

    it('rejects if issue is closed on GitHub', async () => {
      const { batchId } = setupAwaitingBatch();
      const batch = batchRepo.findById(batchId)!;
      batchRepo.update({ ...batch, status: 'test_failed' });

      github.issues.set('test-org/test-repo/102', {
        number: 102,
        title: 'Closed issue',
        state: 'closed',
      });

      const appendUseCase = new AppendRemediationIssues({
        releaseBatchRepository: batchRepo,
        repositoryPort: repoPort,
        github,
        now,
      });

      await expect(
        appendUseCase.execute({
          batchId,
          issueNumbers: [102],
        }),
      ).rejects.toThrow(/closed/i);
    });
  });

  describe('PromoteReleaseBatch', () => {
    it('creates promotion PR, requests auto-merge, and transitions to promoting', async () => {
      const { batchId, candidateSha } = setupAwaitingBatch();
      const batch = batchRepo.findById(batchId)!;
      batchRepo.update({ ...batch, status: 'approved', approvedCandidateSha: candidateSha });

      // In git, all items' merged commit SHAs are ancestors of candidateSha
      git.ancestorResults.set(`${candidateSha}|${candidateSha}`, true);

      const promoteUseCase = new PromoteReleaseBatch({
        releaseBatchRepository: batchRepo,
        repositoryPort: repoPort,
        git,
        github,
        now,
      });

      const result = await promoteUseCase.execute({
        batchId,
        autoMerge: true,
      });

      expect(result.batch.status).toBe('promoting');
      expect(result.prNumber).toBeDefined();

      const createdPr = github.prs.get(`test-org/test-repo/${result.prNumber}`);
      expect(createdPr).toBeDefined();
      expect(createdPr?.baseRefName).toBe('main');
      expect(createdPr?.headRefName).toBe('release/2026-09-11-cand');
      expect(github.autoMergeRequests).toHaveLength(1);
      expect(github.autoMergeRequests[0]?.prNumber).toBe(result.prNumber);
    });

    it('rejects promotion if batch is not approved', async () => {
      const { batchId } = setupAwaitingBatch();
      // Still awaiting_manual_test

      const promoteUseCase = new PromoteReleaseBatch({
        releaseBatchRepository: batchRepo,
        repositoryPort: repoPort,
        git,
        github,
        now,
      });

      await expect(
        promoteUseCase.execute({
          batchId,
        }),
      ).rejects.toThrow(/cannot promote release batch/i);
    });

    it('rejects promotion if release branch remote SHA drifted from candidateSha', async () => {
      const { batchId, candidateSha } = setupAwaitingBatch();
      const batch = batchRepo.findById(batchId)!;
      batchRepo.update({ ...batch, status: 'approved', approvedCandidateSha: candidateSha });

      // Remote release branch changed
      git.remoteRefs.set('origin/release/2026-09-11-cand', 'sha-drifted-head');

      const promoteUseCase = new PromoteReleaseBatch({
        releaseBatchRepository: batchRepo,
        repositoryPort: repoPort,
        git,
        github,
        now,
      });

      await expect(
        promoteUseCase.execute({
          batchId,
        }),
      ).rejects.toThrow(ReleaseBranchDriftError);
    });

    it('rejects promotion if source branch moved ahead of release branch', async () => {
      const { batchId, candidateSha } = setupAwaitingBatch();
      const batch = batchRepo.findById(batchId)!;
      batchRepo.update({ ...batch, status: 'approved', approvedCandidateSha: candidateSha });

      // In git, all items' merged commit SHAs are ancestors of candidateSha
      git.ancestorResults.set(`${candidateSha}|${candidateSha}`, true);
      // Remote main moved ahead and is NOT an ancestor of release branch
      git.remoteRefs.set('origin/main', 'sha-main-unintegrated');
      // No ancestor pair for sha-main-unintegrated|candidateSha

      const promoteUseCase = new PromoteReleaseBatch({
        releaseBatchRepository: batchRepo,
        repositoryPort: repoPort,
        git,
        github,
        now,
      });

      await expect(
        promoteUseCase.execute({
          batchId,
        }),
      ).rejects.toThrow(SourceBranchDriftError);
    });
  });
});
