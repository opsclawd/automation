import { describe, it, expect, beforeEach } from 'vitest';
import { ReleaseBatchId, RepositoryId, createRun } from '@ai-sdlc/domain';
import type { Repository } from '@ai-sdlc/domain';
import { GetReleaseBatchStatus } from '../get-release-batch-status.js';
import { FakeReleaseBatchRepository } from '../test-doubles/fake-release-batch-repository.js';
import { FakeRunRepository } from '../test-doubles/fake-run-repository.js';
import { FakeRepositoryPort } from '../test-doubles/fake-repository-port.js';
import type { GitPort, ReleaseBatchRepositoryPort } from '../ports.js';

describe('GetReleaseBatchStatus', () => {
  let batchRepo: ReleaseBatchRepositoryPort;
  let runRepo: FakeRunRepository;
  let git: GitPort;
  let useCase: GetReleaseBatchStatus;

  beforeEach(() => {
    batchRepo = new FakeReleaseBatchRepository();
    runRepo = new FakeRunRepository();

    git = {
      fetch: async () => {},
      resolveRef: async (_cwd: string, ref: string) => `sha-for-${ref}`,
      isAncestor: async (_cwd: string, _anc: string, _desc: string) => true,
    } as unknown as GitPort;

    const repo: Repository = {
      id: RepositoryId('owner/repo'),
      fullName: 'owner/repo',
      defaultBranch: 'main',
      remoteUrl: 'https://github.com/owner/repo.git',
      localBasePath: '/tmp/repo',
      enabled: true,
      maxConcurrentRuns: 1,
      healthStatus: 'healthy',
      healthError: null,
      lastHealthCheckAt: new Date(),
      configMetadata: '{}',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    useCase = new GetReleaseBatchStatus({
      releaseBatchRepository: batchRepo,
      runRepository: runRepo,
      repositoryPort: new FakeRepositoryPort([repo]),
      git,
    });
  });

  it('throws when release batch is not found', async () => {
    await expect(useCase.execute({ batchId: ReleaseBatchId('non-existent') })).rejects.toThrow(
      'ReleaseBatch non-existent not found',
    );
  });

  it('returns building batch status with formatted lines and items', async () => {
    const batchId = ReleaseBatchId('batch-001');
    const runUuid = 'uuid-run-1';
    const run = createRun({
      uuid: runUuid,
      displayId: 'issue-101-001',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 101,
      startedAt: new Date(),
    });
    run.status = 'running';
    run.currentPhase = 'plan';
    runRepo.insertIfNoActive(run);

    batchRepo.insert({
      id: batchId,
      repoId: RepositoryId('owner/repo'),
      sourceBranch: 'main',
      sourceStartSha: 'sha-main-0',
      releaseBranch: 'release/batch-001',
      status: 'building',
      currentPosition: 1,
      createdAt: new Date(),
      items: [
        {
          position: 1,
          issueNumber: 101,
          status: 'active',
          runUuid,
          startedAt: new Date(),
        },
        {
          position: 2,
          issueNumber: 102,
          status: 'pending',
        },
      ],
    });

    const status = await useCase.execute({ batchId });

    expect(status.id).toBe(batchId);
    expect(status.status).toBe('building');
    expect(status.items.length).toBe(2);
    expect(status.items[0]?.runStatus).toBe('running');
    expect(status.items[0]?.runPhase).toBe('plan');
    expect(status.blocker.owner).toBe('none');
    expect(status.formattedLines.some((l) => l.includes('batch-001'))).toBe(true);
    expect(status.formattedLines.some((l) => l.includes('#101'))).toBe(true);
    expect(status.formattedLines.some((l) => l.includes('#102'))).toBe(true);
  });

  it('detects candidate staleness when release head drifts', async () => {
    const batchId = ReleaseBatchId('batch-002');
    git.resolveRef = async (_cwd: string, ref: string) => {
      if (ref.includes('release/batch-002')) return 'sha-drifted-head';
      return 'sha-source-head';
    };

    batchRepo.insert({
      id: batchId,
      repoId: RepositoryId('owner/repo'),
      sourceBranch: 'main',
      sourceStartSha: 'sha-main-0',
      releaseBranch: 'release/batch-002',
      status: 'awaiting_manual_test',
      currentPosition: 1,
      candidateSha: 'sha-candidate-original',
      createdAt: new Date(),
      items: [
        {
          position: 1,
          issueNumber: 101,
          status: 'merged',
          mergedCommitSha: 'sha-candidate-original',
        },
      ],
    });

    const status = await useCase.execute({ batchId });

    expect(status.candidate.candidateSha).toBe('sha-candidate-original');
    expect(status.candidate.isStale).toBe(true);
  });

  it('classifies Run-owned blocker when an item run fails', async () => {
    const batchId = ReleaseBatchId('batch-003');
    const runUuid = 'uuid-run-fail';
    const run = createRun({
      uuid: runUuid,
      displayId: 'issue-102-001',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 102,
      startedAt: new Date(),
    });
    run.status = 'failed';
    run.currentPhase = 'validation';
    run.completedPhases = ['plan', 'execute'];
    runRepo.insertIfNoActive(run);

    batchRepo.insert({
      id: batchId,
      repoId: RepositoryId('owner/repo'),
      sourceBranch: 'main',
      sourceStartSha: 'sha-main-0',
      releaseBranch: 'release/batch-003',
      status: 'blocked',
      blockedReason: 'run_failed',
      currentPosition: 2,
      createdAt: new Date(),
      items: [
        { position: 1, issueNumber: 101, status: 'merged' },
        {
          position: 2,
          issueNumber: 102,
          status: 'blocked',
          blockedReason: 'run_failed',
          runUuid,
        },
      ],
    });

    const status = await useCase.execute({ batchId });

    expect(status.blocker.owner).toBe('run');
    expect(status.blocker.runUuid).toBe(runUuid);
    expect(status.blocker.runStatus).toBe('failed');
    expect(status.blocker.action).toContain('runs resume --uuid');
  });

  it('reports blocker owner as none when item has stale run_failed but run is passed', async () => {
    const batchId = ReleaseBatchId('batch-003-passed');
    const runUuid = 'uuid-run-passed';
    const run = createRun({
      uuid: runUuid,
      displayId: 'issue-102-002',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 102,
      startedAt: new Date(),
    });
    run.status = 'passed';
    run.currentPhase = 'wait-merge';
    runRepo.insertIfNoActive(run);

    batchRepo.insert({
      id: batchId,
      repoId: RepositoryId('owner/repo'),
      sourceBranch: 'main',
      sourceStartSha: 'sha-main-0',
      releaseBranch: 'release/batch-003-passed',
      status: 'blocked',
      blockedReason: 'run_failed',
      currentPosition: 2,
      createdAt: new Date(),
      items: [
        { position: 1, issueNumber: 101, status: 'merged' },
        {
          position: 2,
          issueNumber: 102,
          status: 'blocked',
          blockedReason: 'run_failed',
          runUuid,
        },
      ],
    });

    const status = await useCase.execute({ batchId });

    expect(status.blocker.owner).toBe('none');
    expect(status.formattedLines.some((l) => l.includes('Owner:          none'))).toBe(true);
  });

  it('includes pinnedRuntime in items, currentItem, and formattedLines when run has pin', async () => {
    const batchId = ReleaseBatchId('batch-pin');
    const runUuid = 'uuid-run-pin';
    const run = createRun({
      uuid: runUuid,
      displayId: 'issue-101-001',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 101,
      startedAt: new Date(),
    });
    run.status = 'running';
    run.currentPhase = 'plan';
    run.pinnedRuntime = 'antigravity';
    runRepo.insertIfNoActive(run);

    batchRepo.insert({
      id: batchId,
      repoId: RepositoryId('owner/repo'),
      sourceBranch: 'main',
      sourceStartSha: 'sha-main-0',
      releaseBranch: 'release/batch-pin',
      status: 'building',
      currentPosition: 1,
      createdAt: new Date(),
      items: [
        {
          position: 1,
          issueNumber: 101,
          status: 'active',
          runUuid,
          startedAt: new Date(),
        },
      ],
    });

    const status = await useCase.execute({ batchId });

    expect(status.items[0]?.pinnedRuntime).toBe('antigravity');
    expect(status.currentItem?.pinnedRuntime).toBe('antigravity');
    expect(status.formattedLines.some((l) => /Runtime Pin:\s+antigravity/.test(l))).toBe(true);
    expect(status.formattedLines.some((l) => l.includes('pin=antigravity'))).toBe(true);
  });

  it('reports Runtime Pin as unpinned when run has no pin', async () => {
    const batchId = ReleaseBatchId('batch-no-pin');
    const runUuid = 'uuid-run-no-pin';
    const run = createRun({
      uuid: runUuid,
      displayId: 'issue-101-002',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 101,
      startedAt: new Date(),
    });
    run.status = 'running';
    run.currentPhase = 'plan';
    runRepo.insertIfNoActive(run);

    batchRepo.insert({
      id: batchId,
      repoId: RepositoryId('owner/repo'),
      sourceBranch: 'main',
      sourceStartSha: 'sha-main-0',
      releaseBranch: 'release/batch-no-pin',
      status: 'building',
      currentPosition: 1,
      createdAt: new Date(),
      items: [
        {
          position: 1,
          issueNumber: 101,
          status: 'active',
          runUuid,
          startedAt: new Date(),
        },
      ],
    });

    const status = await useCase.execute({ batchId });

    expect(status.items[0]?.pinnedRuntime).toBeUndefined();
    expect(status.currentItem?.pinnedRuntime).toBeUndefined();
    expect(status.formattedLines.some((l) => /Runtime Pin:\s+unpinned/.test(l))).toBe(true);
  });

  it('surfaces runStatus as passed and phase omitted for merged items even if runRepository has stale needs_human_review', async () => {
    const batchId = ReleaseBatchId('batch-stale-run');
    const runUuid = 'uuid-run-stale';
    const run = createRun({
      uuid: runUuid,
      displayId: 'issue-101-003',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 101,
      startedAt: new Date(),
    });
    run.status = 'needs_human_review';
    run.currentPhase = 'fix-validate';
    runRepo.insertIfNoActive(run);

    batchRepo.insert({
      id: batchId,
      repoId: RepositoryId('owner/repo'),
      sourceBranch: 'main',
      sourceStartSha: 'sha-main-0',
      releaseBranch: 'release/batch-stale-run',
      status: 'building',
      currentPosition: 1,
      createdAt: new Date(),
      items: [
        {
          position: 1,
          issueNumber: 101,
          status: 'merged',
          runUuid,
          prNumber: 59,
          mergedCommitSha: 'sha-merged-101',
          completedAt: new Date(),
        },
      ],
    });

    const status = await useCase.execute({ batchId });

    // items view should show passed and not fix-validate
    expect(status.items[0]?.runStatus).toBe('passed');
    expect(status.items[0]?.runPhase).toBeUndefined();

    // currentItem view should show passed and completed phase
    expect(status.currentItem?.runStatus).toBe('passed');
    expect(status.currentItem?.currentPhase).toBe('completed');

    // Blocker diagnostics should report none
    expect(status.blocker.owner).toBe('none');

    // Run in runRepo should be healed to passed
    const healedRun = runRepo.findByUuid(runUuid)!;
    expect(healedRun.status).toBe('passed');
    expect(healedRun.currentPhase).toBeUndefined();

    // Formatted lines should not report phase=fix-validate
    expect(status.formattedLines.some((l) => l.includes('phase=fix-validate'))).toBe(false);
    expect(status.formattedLines.some((l) => /Run Status:\s+passed/.test(l))).toBe(true);
    expect(status.formattedLines.some((l) => /Run Phase:\s+completed/.test(l))).toBe(true);
  });
});
