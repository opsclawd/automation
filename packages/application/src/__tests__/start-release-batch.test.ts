import { describe, it, expect, beforeEach } from 'vitest';
import {
  RepositoryId,
  type Repository,
  RepositoryNotApprovedError,
  RepositoryValidationError,
} from '@ai-sdlc/domain';
import {
  StartReleaseBatch,
  ReleaseBatchValidationError,
  ReleaseBatchPreflightError,
  ReleaseBranchConflictError,
} from '../start-release-batch.js';
import { FakeReleaseBatchRepository } from '../test-doubles/fake-release-batch-repository.js';
import { FakeRunRepository } from '../test-doubles/fake-run-repository.js';
import { FakeJobQueuePort } from '../test-doubles/fake-job-queue-port.js';
import { FakeGitPort } from '../test-doubles/fake-git-port.js';
import { FakeGitHubPort } from '../test-doubles/fake-github-port.js';
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

describe('StartReleaseBatch', () => {
  let releaseBatchRepository: FakeReleaseBatchRepository;
  let runRepository: FakeRunRepository;
  let repositoryPort: FakeRepositoryPort;
  let jobQueue: FakeJobQueuePort;
  let git: FakeGitPort;
  let github: FakeGitHubPort;
  let eventBus: FakeEventBus;
  let startReleaseBatch: StartReleaseBatch;
  let defaultRepo: Repository;

  const fixedNow = new Date('2026-09-11T12:00:00.000Z');

  beforeEach(() => {
    defaultRepo = createTestRepo();
    repositoryPort = new FakeRepositoryPort([defaultRepo]);
    releaseBatchRepository = new FakeReleaseBatchRepository();
    runRepository = new FakeRunRepository();
    jobQueue = new FakeJobQueuePort(repositoryPort);
    git = new FakeGitPort();
    github = new FakeGitHubPort();
    eventBus = new FakeEventBus();

    // Default GitHub issue fixtures
    for (const num of [101, 102, 103, 104, 105]) {
      github.issues.set(`test-org/test-repo/${num}`, {
        number: num,
        title: `Issue ${num}`,
        body: `Body ${num}`,
        author: 'gary',
        state: 'OPEN',
        labels: [],
        createdAt: fixedNow.toISOString(),
        updatedAt: fixedNow.toISOString(),
      });
    }

    // Default git ref setup: remote main resolves to sha-main-123
    git.remoteRefs.set('origin/main', 'sha-main-123');

    startReleaseBatch = new StartReleaseBatch({
      releaseBatchRepository,
      runRepository,
      jobQueue,
      repositoryPort,
      git,
      github,
      eventBus,
      now: () => fixedNow,
    });
  });

  it('successfully starts release batch with 5 issues, admitting only item 0 with run and job', async () => {
    const result = await startReleaseBatch.execute({
      issueNumbers: [101, 102, 103, 104, 105],
    });

    expect(result.batchId).toBeDefined();
    expect(result.releaseBranch).toBe('release/2026-09-11-batch-101-102-103-104-105');
    expect(result.sourceBranch).toBe('main');
    expect(result.sourceStartSha).toBe('sha-main-123');
    expect(result.runUuid).toBeDefined();
    expect(result.runDisplayId).toBeDefined();
    expect(result.jobId).toBeDefined();

    // Git calls
    expect(git.fetchCalls).toEqual([{ cwd: '/tmp/test-repo', remote: 'origin', ref: 'main' }]);
    expect(git.createBranchCalls).toEqual([
      {
        cwd: '/tmp/test-repo',
        branch: result.releaseBranch,
        startPoint: 'sha-main-123',
      },
    ]);
    expect(git.pushes).toEqual([
      {
        cwd: '/tmp/test-repo',
        branch: result.releaseBranch,
        remote: 'origin',
      },
    ]);

    // GitHub capability verified
    expect(github.verifyCapabilitiesCalls).toContain('test-org/test-repo');

    // Batch record in repository
    const savedBatch = releaseBatchRepository.findById(result.batchId);
    expect(savedBatch).toBeDefined();
    expect(savedBatch?.status).toBe('building');
    expect(savedBatch?.sourceStartSha).toBe('sha-main-123');
    expect(savedBatch?.releaseBranch).toBe(result.releaseBranch);
    expect(savedBatch?.items).toHaveLength(5);

    // Positions are 1-indexed, ordering preserved
    expect(savedBatch?.items.map((i) => ({ pos: i.position, num: i.issueNumber }))).toEqual([
      { pos: 1, num: 101 },
      { pos: 2, num: 102 },
      { pos: 3, num: 103 },
      { pos: 4, num: 104 },
      { pos: 5, num: 105 },
    ]);

    // Item 0 (pos 1) admitted with Run UUID and baseSha
    expect(savedBatch?.items[0]).toMatchObject({
      position: 1,
      issueNumber: 101,
      status: 'active',
      runUuid: result.runUuid,
      baseSha: 'sha-main-123',
    });

    // Items 1..4 (pos 2..5) remain pending without Run UUID
    for (let i = 1; i < 5; i++) {
      expect(savedBatch?.items[i]?.status).toBe('pending');
      expect(savedBatch?.items[i]?.runUuid).toBeUndefined();
    }

    // Run record created with baseBranch pointing to releaseBranch
    const run = runRepository.findByUuid(result.runUuid);
    expect(run).toBeDefined();
    expect(run?.baseBranch).toBe(result.releaseBranch);
    expect(run?.issueNumber).toBe(101);
    expect(run?.repoId).toBe(defaultRepo.id);

    // Job record queued for item 0
    const job = jobQueue.findById(result.jobId);
    expect(job).toBeDefined();
    expect(job?.runId).toBe(result.runUuid);
    expect(job?.issueNumber).toBe(101);
    expect(job?.status).toBe('queued');

    // Structured event emitted
    const emitted = eventBus.published.find((p) => p.event.type === 'release_batch.started');
    expect(emitted).toBeDefined();
    expect(emitted?.runUuid).toBe(result.runUuid);
    expect(emitted?.event.metadata).toMatchObject({
      releaseBatchId: result.batchId,
      releaseBranch: result.releaseBranch,
      sourceBranch: 'main',
      sourceStartSha: 'sha-main-123',
      initialIssue: 101,
      runUuid: result.runUuid,
    });
  });

  it('respects custom releaseBranch and custom sourceBranch', async () => {
    git.remoteRefs.set('origin/release-base', 'sha-custom-999');

    const result = await startReleaseBatch.execute({
      issueNumbers: [101, 102],
      sourceBranch: 'release-base',
      releaseBranch: 'release/v2.1.0',
    });

    expect(result.releaseBranch).toBe('release/v2.1.0');
    expect(result.sourceBranch).toBe('release-base');
    expect(result.sourceStartSha).toBe('sha-custom-999');

    expect(git.createBranchCalls).toEqual([
      {
        cwd: '/tmp/test-repo',
        branch: 'release/v2.1.0',
        startPoint: 'sha-custom-999',
      },
    ]);
  });

  it('allows idempotent retry when release branch already exists pointing to the exact sourceStartSha', async () => {
    git.remoteRefs.set('origin/main', 'sha-main-123');
    // Release branch already points to the same sha
    git.remoteRefs.set('origin/release/v2.0.0', 'sha-main-123');

    const result = await startReleaseBatch.execute({
      issueNumbers: [101, 102],
      releaseBranch: 'release/v2.0.0',
    });

    expect(result.releaseBranch).toBe('release/v2.0.0');
    expect(result.sourceStartSha).toBe('sha-main-123');
    // Branch creation should be skipped since it already exists at exact commit
    expect(git.createBranchCalls).toHaveLength(0);
  });

  it('rejects with ReleaseBranchConflictError when release branch already exists pointing to a DIFFERENT commit', async () => {
    git.remoteRefs.set('origin/main', 'sha-main-123');
    // Remote release branch points to a conflicting commit
    git.remoteRefs.set('origin/release/conflicting', 'sha-diverged-456');

    await expect(
      startReleaseBatch.execute({
        issueNumbers: [101, 102],
        releaseBranch: 'release/conflicting',
      }),
    ).rejects.toThrow(ReleaseBranchConflictError);

    // Atomic guarantee: no records created
    expect(releaseBatchRepository.listForRepo(defaultRepo.id)).toHaveLength(0);
    expect(runRepository.runs.size).toBe(0);
    expect(jobQueue.listActive()).toHaveLength(0);
  });

  it('rejects empty issue numbers with ReleaseBatchValidationError and zero partial state', async () => {
    await expect(
      startReleaseBatch.execute({
        issueNumbers: [],
      }),
    ).rejects.toThrow(ReleaseBatchValidationError);

    expect(releaseBatchRepository.listForRepo(defaultRepo.id)).toHaveLength(0);
    expect(runRepository.runs.size).toBe(0);
    expect(jobQueue.listActive()).toHaveLength(0);
  });

  it('rejects duplicate issue numbers with ReleaseBatchValidationError and zero partial state', async () => {
    await expect(
      startReleaseBatch.execute({
        issueNumbers: [101, 102, 101],
      }),
    ).rejects.toThrow(ReleaseBatchValidationError);

    expect(releaseBatchRepository.listForRepo(defaultRepo.id)).toHaveLength(0);
    expect(runRepository.runs.size).toBe(0);
    expect(jobQueue.listActive()).toHaveLength(0);
  });

  it('rejects non-existent issues with ReleaseBatchPreflightError and zero partial state', async () => {
    // 999 is not in github.issues
    await expect(
      startReleaseBatch.execute({
        issueNumbers: [101, 999],
      }),
    ).rejects.toThrow(ReleaseBatchPreflightError);

    expect(releaseBatchRepository.listForRepo(defaultRepo.id)).toHaveLength(0);
    expect(runRepository.runs.size).toBe(0);
    expect(jobQueue.listActive()).toHaveLength(0);
  });

  it('rejects when target repository is not approved or disabled with RepositoryNotApprovedError', async () => {
    const disabledRepo = createTestRepo({
      id: RepositoryId('disabled/repo'),
      fullName: 'disabled/repo',
      enabled: false,
    });
    repositoryPort = new FakeRepositoryPort([disabledRepo]);

    const batchUseCase = new StartReleaseBatch({
      releaseBatchRepository,
      runRepository,
      jobQueue,
      repositoryPort,
      git,
      github,
      eventBus,
    });

    await expect(
      batchUseCase.execute({
        repoId: disabledRepo.id,
        issueNumbers: [101],
      }),
    ).rejects.toThrow(RepositoryNotApprovedError);

    expect(releaseBatchRepository.listForRepo(disabledRepo.id)).toHaveLength(0);
  });

  it('rejects when repository health is degraded with RepositoryNotApprovedError', async () => {
    const degradedRepo = createTestRepo({
      healthStatus: 'degraded',
      healthError: 'disk full',
    });
    repositoryPort = new FakeRepositoryPort([degradedRepo]);

    const batchUseCase = new StartReleaseBatch({
      releaseBatchRepository,
      runRepository,
      jobQueue,
      repositoryPort,
      git,
      github,
      eventBus,
    });

    await expect(
      batchUseCase.execute({
        repoId: degradedRepo.id,
        issueNumbers: [101],
      }),
    ).rejects.toThrow(RepositoryNotApprovedError);

    expect(releaseBatchRepository.listForRepo(degradedRepo.id)).toHaveLength(0);
  });

  it('rejects when source branch cannot be resolved with ReleaseBatchPreflightError and zero partial state', async () => {
    // Clear remoteRefs so resolveRef returns undefined
    git.remoteRefs.clear();

    await expect(
      startReleaseBatch.execute({
        issueNumbers: [101, 102],
        sourceBranch: 'nonexistent-branch',
      }),
    ).rejects.toThrow(ReleaseBatchPreflightError);

    expect(releaseBatchRepository.listForRepo(defaultRepo.id)).toHaveLength(0);
    expect(runRepository.runs.size).toBe(0);
    expect(jobQueue.listActive()).toHaveLength(0);
  });

  it('rejects when GitHub capabilities check fails with ReleaseBatchPreflightError and zero partial state', async () => {
    github.viewerPermissionByRepo.set('test-org/test-repo', 'READ');

    await expect(
      startReleaseBatch.execute({
        issueNumbers: [101, 102],
      }),
    ).rejects.toThrow(ReleaseBatchPreflightError);

    expect(releaseBatchRepository.listForRepo(defaultRepo.id)).toHaveLength(0);
    expect(runRepository.runs.size).toBe(0);
    expect(jobQueue.listActive()).toHaveLength(0);
  });

  it('rejects when GitHub repository has auto-merge disabled with ReleaseBatchPreflightError and zero partial state', async () => {
    github.autoMergeAllowedByRepo.set('test-org/test-repo', false);

    await expect(
      startReleaseBatch.execute({
        issueNumbers: [101, 102],
      }),
    ).rejects.toThrow(/auto-merge is disabled for repository/);

    expect(releaseBatchRepository.listForRepo(defaultRepo.id)).toHaveLength(0);
    expect(runRepository.runs.size).toBe(0);
    expect(jobQueue.listActive()).toHaveLength(0);
  });

  it('rejects ambiguous repository when multiple enabled repos exist and repoId is omitted', async () => {
    const secondRepo = createTestRepo({
      id: RepositoryId('test-org/another-repo'),
      fullName: 'test-org/another-repo',
    });
    repositoryPort = new FakeRepositoryPort([defaultRepo, secondRepo]);

    const batchUseCase = new StartReleaseBatch({
      releaseBatchRepository,
      runRepository,
      jobQueue,
      repositoryPort,
      git,
      github,
      eventBus,
    });

    await expect(
      batchUseCase.execute({
        issueNumbers: [101],
      }),
    ).rejects.toThrow(RepositoryValidationError);

    expect(releaseBatchRepository.listForRepo(defaultRepo.id)).toHaveLength(0);
  });
});
