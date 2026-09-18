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
import { FakeEventBus } from '../test-doubles/fake-event-bus.js';

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

    it('publishes its event under a real item run uuid, not the batch id (#1249)', async () => {
      const { batchId, candidateSha } = setupAwaitingBatch();
      const eventBus = new FakeEventBus();
      const approveUseCase = new ApproveReleaseBatchCandidate({
        releaseBatchRepository: batchRepo,
        repositoryPort: repoPort,
        git,
        eventBus,
        now,
      });

      await approveUseCase.execute({ batchId, candidateSha });

      expect(eventBus.published.length).toBeGreaterThan(0);
      for (const { runUuid } of eventBus.published) {
        expect(runUuid).toBe('run-001');
        expect(runUuid).not.toBe(batchId);
      }
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
      expect(github.createdPrInputs[0]?.body).toContain(`## Release Promotion: \`${batchId}\``);
      expect(github.createdPrInputs[0]?.body).toContain(`\`${candidateSha}\``);
      expect(github.createdPrInputs[0]?.body).toContain('Closes #101');
    });

    it('includes Closes #N for all batch items in promotion PR body', async () => {
      const batchId = ReleaseBatchId('batch-gate-multi');
      const candidateSha = 'sha-cand-multi';
      let batch = createReleaseBatch({
        id: batchId,
        repoId: defaultRepo.id,
        sourceBranch: 'main',
        sourceStartSha: 'sha-main-001',
        releaseBranch: 'release/2026-09-11-multi',
        items: [
          { position: 1, issueNumber: 201 },
          { position: 2, issueNumber: 202 },
          { position: 3, issueNumber: 203 },
        ],
        createdAt: new Date('2026-09-11T12:00:00.000Z'),
      });

      batch = admitItem(batch, 1, { runUuid: 'run-201', baseSha: 'sha-main-001' });
      batch = markItemMerged(batch, 1, { mergedCommitSha: 'sha-m-201' });
      batch = admitItem(batch, 2, { runUuid: 'run-202', baseSha: 'sha-m-201' });
      batch = markItemMerged(batch, 2, { mergedCommitSha: 'sha-m-202' });
      batch = admitItem(batch, 3, { runUuid: 'run-203', baseSha: 'sha-m-202' });
      batch = markItemMerged(batch, 3, { mergedCommitSha: candidateSha });

      batch = {
        ...batch,
        status: 'approved',
        candidateSha,
        approvedCandidateSha: candidateSha,
      };
      batchRepo.insert(batch);

      git.remoteRefs.set('origin/release/2026-09-11-multi', candidateSha);
      git.remoteRefs.set('origin/main', 'sha-main-001');
      git.ancestorResults.set(`sha-main-001|${candidateSha}`, true);
      git.ancestorResults.set(`sha-m-201|${candidateSha}`, true);
      git.ancestorResults.set(`sha-m-202|${candidateSha}`, true);
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
      expect(github.createdPrInputs).toHaveLength(1);
      expect(github.createdPrInputs[0]?.title).toBe('Release batch-gate-multi: #201, #202, #203');
      expect(github.createdPrInputs[0]?.body).toContain('Closes #201');
      expect(github.createdPrInputs[0]?.body).toContain('Closes #202');
      expect(github.createdPrInputs[0]?.body).toContain('Closes #203');
      expect(github.createdPrInputs[0]?.body).toContain('`sha-cand-multi`');
    });

    it('idempotently promotes using existing promotionPrNumber without creating duplicate PR', async () => {
      const { batchId, candidateSha } = setupAwaitingBatch();
      const batch = batchRepo.findById(batchId)!;
      batchRepo.update({
        ...batch,
        status: 'approved',
        approvedCandidateSha: candidateSha,
        promotionPrNumber: 888,
      });

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
      expect(result.prNumber).toBe(888);
      // Ensure NO new PR was created via github.createPullRequest
      expect(github.createdPrInputs).toHaveLength(0);
      expect(github.autoMergeRequests).toHaveLength(1);
      expect(github.autoMergeRequests[0]?.prNumber).toBe(888);
    });

    it('refreshes existing promotion PR candidate SHA and Closes list on re-promote after reject and remediation (#1258)', async () => {
      const batchId = ReleaseBatchId('batch-gate-repromote');
      const candidateSha1 = 'sha-cand-first';
      let batch = createReleaseBatch({
        id: batchId,
        repoId: defaultRepo.id,
        sourceBranch: 'main',
        sourceStartSha: 'sha-main-001',
        releaseBranch: 'release/2026-09-11-repromote',
        items: [{ position: 1, issueNumber: 101 }],
        createdAt: new Date('2026-09-11T12:00:00.000Z'),
      });

      batch = admitItem(batch, 1, { runUuid: 'run-101', baseSha: 'sha-main-001' });
      batch = markItemMerged(batch, 1, { mergedCommitSha: candidateSha1 });
      batch = {
        ...batch,
        status: 'awaiting_manual_test',
        candidateSha: candidateSha1,
        candidateTreeSha: 'tree-' + candidateSha1,
      };
      batchRepo.insert(batch);

      git.remoteRefs.set('origin/release/2026-09-11-repromote', candidateSha1);
      git.remoteRefs.set('origin/main', 'sha-main-001');
      git.ancestorResults.set(`sha-main-001|${candidateSha1}`, true);
      git.ancestorResults.set(`${candidateSha1}|${candidateSha1}`, true);

      const approveUseCase = new ApproveReleaseBatchCandidate({
        releaseBatchRepository: batchRepo,
        repositoryPort: repoPort,
        git,
        now,
      });
      const rejectUseCase = new RejectReleaseBatchCandidate({
        releaseBatchRepository: batchRepo,
        now,
      });
      const appendRemediationUseCase = new AppendRemediationIssues({
        releaseBatchRepository: batchRepo,
        github,
        now,
      });
      const promoteUseCase = new PromoteReleaseBatch({
        releaseBatchRepository: batchRepo,
        repositoryPort: repoPort,
        git,
        github,
        now,
      });

      // 1. Approve initial candidate
      await approveUseCase.execute({ batchId, candidateSha: candidateSha1 });

      // 2. Promote initial batch -> PR created with issue 101 and candidateSha1
      const initialPromo = await promoteUseCase.execute({ batchId });
      expect(initialPromo.prNumber).toBeDefined();
      const prNumber = initialPromo.prNumber!;
      expect(github.createdPrInputs).toHaveLength(1);
      expect(github.createdPrInputs[0]?.title).toBe('Release batch-gate-repromote: #101');
      expect(github.createdPrInputs[0]?.body).toContain('Closes #101');
      expect(github.createdPrInputs[0]?.body).toContain(`\`${candidateSha1}\``);

      // 3. Reject candidate
      // Reset status to awaiting_manual_test to simulate re-evaluating or manual reject
      batch = batchRepo.findById(batchId)!;
      batchRepo.update({ ...batch, status: 'awaiting_manual_test' });
      await rejectUseCase.execute({ batchId, candidateSha: candidateSha1 });

      // 4. Append remediation issue 102
      github.issues.set('test-org/test-repo/102', {
        number: 102,
        title: 'Remediation Fix',
        body: 'Fixes problem found in review',
        labels: [],
        state: 'open',
      });
      await appendRemediationUseCase.execute({ batchId, issueNumbers: [102] });

      // Simulate remediation run admitting and merging
      const candidateSha2 = 'sha-cand-remediated';
      batch = batchRepo.findById(batchId)!;
      batch = admitItem(batch, 2, { runUuid: 'run-102', baseSha: candidateSha1 });
      batch = markItemMerged(batch, 2, { mergedCommitSha: candidateSha2 });
      batch = {
        ...batch,
        status: 'awaiting_manual_test',
        candidateSha: candidateSha2,
        candidateTreeSha: 'tree-' + candidateSha2,
      };
      batchRepo.update(batch);

      git.remoteRefs.set('origin/release/2026-09-11-repromote', candidateSha2);
      git.ancestorResults.set(`sha-main-001|${candidateSha2}`, true);
      git.ancestorResults.set(`${candidateSha1}|${candidateSha2}`, true);
      git.ancestorResults.set(`${candidateSha2}|${candidateSha2}`, true);

      // 5. Re-approve with new candidate SHA
      await approveUseCase.execute({ batchId, candidateSha: candidateSha2 });

      // 6. Re-promote
      const rePromo = await promoteUseCase.execute({ batchId });
      expect(rePromo.prNumber).toBe(prNumber);
      // Ensure no duplicate PR was created
      expect(github.createdPrInputs).toHaveLength(1);

      // 7. Verify PR was updated via updatePullRequest
      const updatedPr = await github.getPr('test-org/test-repo', prNumber);
      expect(updatedPr.title).toBe('Release batch-gate-repromote: #101, #102');
      expect(updatedPr.body).toContain('| **Candidate SHA** | `sha-cand-remediated` |');
      expect(updatedPr.body).not.toContain('| **Candidate SHA** | `sha-cand-first` |');
      expect(updatedPr.body).toContain(
        '- Release candidate commit `sha-cand-remediated` contains all constituent merge commits.',
      );
      expect(updatedPr.body).toContain('Closes #101\nCloses #102');
    });

    it('publishes its event under the most recent item run uuid, not the batch id (#1249)', async () => {
      const batchId = ReleaseBatchId('batch-gate-event');
      const candidateSha = 'sha-cand-event';
      let batch = createReleaseBatch({
        id: batchId,
        repoId: defaultRepo.id,
        sourceBranch: 'main',
        sourceStartSha: 'sha-main-001',
        releaseBranch: 'release/2026-09-11-event',
        items: [
          { position: 1, issueNumber: 201 },
          { position: 2, issueNumber: 202 },
        ],
        createdAt: new Date('2026-09-11T12:00:00.000Z'),
      });

      batch = admitItem(batch, 1, { runUuid: 'run-201', baseSha: 'sha-main-001' });
      batch = markItemMerged(batch, 1, { mergedCommitSha: 'sha-m-201' });
      batch = admitItem(batch, 2, { runUuid: 'run-202', baseSha: 'sha-m-201' });
      batch = markItemMerged(batch, 2, { mergedCommitSha: candidateSha });

      batch = {
        ...batch,
        status: 'approved',
        candidateSha,
        approvedCandidateSha: candidateSha,
      };
      batchRepo.insert(batch);

      git.remoteRefs.set('origin/release/2026-09-11-event', candidateSha);
      git.remoteRefs.set('origin/main', 'sha-main-001');
      git.ancestorResults.set(`sha-main-001|${candidateSha}`, true);
      git.ancestorResults.set(`sha-m-201|${candidateSha}`, true);
      git.ancestorResults.set(`${candidateSha}|${candidateSha}`, true);

      const eventBus = new FakeEventBus();
      const promoteUseCase = new PromoteReleaseBatch({
        releaseBatchRepository: batchRepo,
        repositoryPort: repoPort,
        git,
        github,
        eventBus,
        now,
      });

      await promoteUseCase.execute({ batchId, autoMerge: true });

      expect(eventBus.published.length).toBeGreaterThan(0);
      for (const { runUuid } of eventBus.published) {
        expect(runUuid).toBe('run-202');
        expect(runUuid).not.toBe(batchId);
      }
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
