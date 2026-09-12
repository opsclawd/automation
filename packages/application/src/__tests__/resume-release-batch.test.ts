import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReleaseBatchId, RepositoryId, ReleaseBatchStateError, createRun } from '@ai-sdlc/domain';
import { ResumeReleaseBatch, RunOwnedBlockerError } from '../resume-release-batch.js';
import { FakeReleaseBatchRepository } from '../test-doubles/fake-release-batch-repository.js';
import { FakeRunRepository } from '../test-doubles/fake-run-repository.js';
import type { ReleaseBatchRepositoryPort } from '../ports.js';
import type { ReleaseBatchCoordinator } from '../release-batch-coordinator.js';

describe('ResumeReleaseBatch', () => {
  let batchRepo: ReleaseBatchRepositoryPort;
  let runRepo: FakeRunRepository;
  let coordinator: ReleaseBatchCoordinator;
  let useCase: ResumeReleaseBatch;

  beforeEach(() => {
    batchRepo = new FakeReleaseBatchRepository();
    runRepo = new FakeRunRepository();

    coordinator = {
      integrateSourceBranch: vi.fn().mockResolvedValue({
        success: true,
        newReleaseSha: 'sha-integrated-head',
      }),
      reconcile: vi.fn().mockImplementation(async (batchId) => {
        const b = batchRepo.findById(batchId)!;
        return {
          batch: b,
          actions: ['status_reconciled'],
        };
      }),
    } as unknown as ReleaseBatchCoordinator;

    useCase = new ResumeReleaseBatch({
      releaseBatchRepository: batchRepo,
      runRepository: runRepo,
      coordinator,
    });
  });

  it('throws ReleaseBatchStateError when batch does not exist', async () => {
    await expect(useCase.execute({ batchId: ReleaseBatchId('non-existent') })).rejects.toThrowError(
      ReleaseBatchStateError,
    );
  });

  it('throws ReleaseBatchStateError when batch is in terminal state', async () => {
    const batchId = ReleaseBatchId('batch-completed');
    batchRepo.insert({
      id: batchId,
      repoId: RepositoryId('owner/repo'),
      sourceBranch: 'main',
      sourceStartSha: 'sha-0',
      releaseBranch: 'release/batch-completed',
      status: 'completed',
      currentPosition: 1,
      createdAt: new Date(),
      items: [{ position: 1, issueNumber: 101, status: 'merged' }],
    });

    await expect(useCase.execute({ batchId })).rejects.toThrowError(ReleaseBatchStateError);
  });

  it('throws RunOwnedBlockerError and directs to runs resume when item run failed', async () => {
    const batchId = ReleaseBatchId('batch-run-blocked');
    const runUuid = 'uuid-failing-run';
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
      sourceStartSha: 'sha-0',
      releaseBranch: 'release/batch-run-blocked',
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

    await expect(useCase.execute({ batchId })).rejects.toThrowError(RunOwnedBlockerError);

    try {
      await useCase.execute({ batchId });
      expect.fail('should have thrown RunOwnedBlockerError');
    } catch (err) {
      expect(err).toBeInstanceOf(RunOwnedBlockerError);
      const blockerErr = err as RunOwnedBlockerError;
      expect(blockerErr.batchId).toBe(batchId);
      expect(blockerErr.runUuid).toBe(runUuid);
      expect(blockerErr.issueNumber).toBe(102);
      expect(blockerErr.runStatus).toBe('failed');
      expect(blockerErr.message).toContain(`runs resume --uuid ${runUuid}`);
    }
  });

  it('resumes batch-level blocker by integrating source drift and reconciling', async () => {
    const batchId = ReleaseBatchId('batch-source-drift');
    batchRepo.insert({
      id: batchId,
      repoId: RepositoryId('owner/repo'),
      sourceBranch: 'main',
      sourceStartSha: 'sha-0',
      releaseBranch: 'release/batch-source-drift',
      status: 'blocked',
      blockedReason: 'source_branch_advanced',
      currentPosition: 1,
      createdAt: new Date(),
      items: [{ position: 1, issueNumber: 101, status: 'waiting_merge' }],
    });

    const result = await useCase.execute({ batchId });

    expect(coordinator.integrateSourceBranch).toHaveBeenCalledWith(batchId);
    expect(coordinator.reconcile).toHaveBeenCalledWith(batchId);
    expect(result.actions).toContain('source_drift_integrated');
    expect(result.actions).toContain('status_reconciled');
  });
});
