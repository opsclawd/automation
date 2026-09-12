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
});
