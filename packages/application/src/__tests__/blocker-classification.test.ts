import { describe, it, expect } from 'vitest';
import { ReleaseBatchId, RepositoryId, createRun, type ReleaseBatch } from '@ai-sdlc/domain';
import { classifyReleaseBatchBlocker } from '../blocker-classification.js';

describe('classifyReleaseBatchBlocker', () => {
  const repoId = RepositoryId('owner/repo');
  const batchId = ReleaseBatchId('batch-001');

  function makeBatch(overrides: Partial<ReleaseBatch> = {}): ReleaseBatch {
    return {
      id: batchId,
      repoId,
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
          runUuid: 'uuid-run-101',
        },
      ],
      ...overrides,
    };
  }

  it('classifies as owner: none when batch is healthy and run is running', () => {
    const batch = makeBatch();
    const run = createRun({
      uuid: 'uuid-run-101',
      displayId: 'issue-101-001',
      repoId,
      issueNumber: 101,
      startedAt: new Date(),
    });
    run.status = 'running';

    const blocker = classifyReleaseBatchBlocker(batch, run);
    expect(blocker.owner).toBe('none');
  });

  it('classifies as owner: run when currentRun has failed status', () => {
    const batch = makeBatch({
      status: 'blocked',
      blockedReason: 'run_failed',
      items: [
        {
          position: 1,
          issueNumber: 101,
          status: 'blocked',
          blockedReason: 'run_failed',
          runUuid: 'uuid-run-101',
        },
      ],
    });
    const run = createRun({
      uuid: 'uuid-run-101',
      displayId: 'issue-101-001',
      repoId,
      issueNumber: 101,
      startedAt: new Date(),
    });
    run.status = 'failed';

    const blocker = classifyReleaseBatchBlocker(batch, run);
    expect(blocker.owner).toBe('run');
    expect(blocker.runUuid).toBe('uuid-run-101');
    expect(blocker.runStatus).toBe('failed');
    expect(blocker.action).toContain('runs resume --uuid uuid-run-101');
  });

  it('classifies as owner: run when currentRun has needs_human_review status', () => {
    const batch = makeBatch({
      status: 'blocked',
      blockedReason: 'needs_human_review',
      items: [
        {
          position: 1,
          issueNumber: 101,
          status: 'blocked',
          blockedReason: 'needs_human_review',
          runUuid: 'uuid-run-101',
        },
      ],
    });
    const run = createRun({
      uuid: 'uuid-run-101',
      displayId: 'issue-101-001',
      repoId,
      issueNumber: 101,
      startedAt: new Date(),
    });
    run.status = 'needs_human_review';

    const blocker = classifyReleaseBatchBlocker(batch, run);
    expect(blocker.owner).toBe('run');
    expect(blocker.runStatus).toBe('needs_human_review');
  });

  it('classifies as owner: run when currentRun is null and stored reason is run_failed', () => {
    const batch = makeBatch({
      status: 'blocked',
      blockedReason: 'run_failed',
      items: [
        {
          position: 1,
          issueNumber: 101,
          status: 'blocked',
          blockedReason: 'run_failed',
          runUuid: 'uuid-run-101',
        },
      ],
    });

    const blocker = classifyReleaseBatchBlocker(batch, null);
    expect(blocker.owner).toBe('run');
    expect(blocker.runUuid).toBe('uuid-run-101');
  });

  it('classifies as owner: none when item has stale run_failed reason but currentRun status is passed', () => {
    const batch = makeBatch({
      status: 'blocked',
      blockedReason: 'run_failed',
      items: [
        {
          position: 1,
          issueNumber: 101,
          status: 'blocked',
          blockedReason: 'run_failed',
          runUuid: 'uuid-run-101',
        },
      ],
    });
    const run = createRun({
      uuid: 'uuid-run-101',
      displayId: 'issue-101-001',
      repoId,
      issueNumber: 101,
      startedAt: new Date(),
    });
    run.status = 'passed';

    const blocker = classifyReleaseBatchBlocker(batch, run);
    expect(blocker.owner).toBe('none');
  });

  it('classifies as owner: none when item has stale needs_human_review but currentRun status is running', () => {
    const batch = makeBatch({
      status: 'blocked',
      blockedReason: 'needs_human_review',
      items: [
        {
          position: 1,
          issueNumber: 101,
          status: 'blocked',
          blockedReason: 'needs_human_review',
          runUuid: 'uuid-run-101',
        },
      ],
    });
    const run = createRun({
      uuid: 'uuid-run-101',
      displayId: 'issue-101-001',
      repoId,
      issueNumber: 101,
      startedAt: new Date(),
    });
    run.status = 'running';

    const blocker = classifyReleaseBatchBlocker(batch, run);
    expect(blocker.owner).toBe('none');
  });

  it('classifies as owner: none when item has stale run_cancelled but currentRun status is queued', () => {
    const batch = makeBatch({
      status: 'blocked',
      blockedReason: 'run_cancelled',
      items: [
        {
          position: 1,
          issueNumber: 101,
          status: 'blocked',
          blockedReason: 'run_cancelled',
          runUuid: 'uuid-run-101',
        },
      ],
    });
    const run = createRun({
      uuid: 'uuid-run-101',
      displayId: 'issue-101-001',
      repoId,
      issueNumber: 101,
      startedAt: new Date(),
    });
    run.status = 'queued';

    const blocker = classifyReleaseBatchBlocker(batch, run);
    expect(blocker.owner).toBe('none');
  });

  it('preserves release blocker when batch has source_branch_advanced even if item has stale run_failed', () => {
    const batch = makeBatch({
      status: 'blocked',
      blockedReason: 'source_branch_advanced',
      items: [
        {
          position: 1,
          issueNumber: 101,
          status: 'blocked',
          blockedReason: 'run_failed',
          runUuid: 'uuid-run-101',
        },
      ],
    });
    const run = createRun({
      uuid: 'uuid-run-101',
      displayId: 'issue-101-001',
      repoId,
      issueNumber: 101,
      startedAt: new Date(),
    });
    run.status = 'passed';

    const blocker = classifyReleaseBatchBlocker(batch, run);
    expect(blocker.owner).toBe('release');
    expect(blocker.reason).toBe('source_branch_advanced');
  });

  it('preserves environment blocker when batch has environment_unhealthy even if run is passed', () => {
    const batch = makeBatch({
      status: 'blocked',
      blockedReason: 'environment_unhealthy',
      items: [
        {
          position: 1,
          issueNumber: 101,
          status: 'blocked',
          blockedReason: 'run_failed',
          runUuid: 'uuid-run-101',
        },
      ],
    });
    const run = createRun({
      uuid: 'uuid-run-101',
      displayId: 'issue-101-001',
      repoId,
      issueNumber: 101,
      startedAt: new Date(),
    });
    run.status = 'passed';

    const blocker = classifyReleaseBatchBlocker(batch, run);
    expect(blocker.owner).toBe('environment');
    expect(blocker.reason).toBe('environment_unhealthy');
  });

  it('preserves github blocker when item has ci_failed even if run is passed', () => {
    const batch = makeBatch({
      status: 'blocked',
      blockedReason: 'ci_failed: checks failed',
      items: [
        {
          position: 1,
          issueNumber: 101,
          status: 'blocked',
          blockedReason: 'ci_failed: checks failed',
          runUuid: 'uuid-run-101',
        },
      ],
    });
    const run = createRun({
      uuid: 'uuid-run-101',
      displayId: 'issue-101-001',
      repoId,
      issueNumber: 101,
      startedAt: new Date(),
    });
    run.status = 'passed';

    const blocker = classifyReleaseBatchBlocker(batch, run);
    expect(blocker.owner).toBe('github');
    expect(blocker.reason).toBe('ci_failed: checks failed');
  });
});
