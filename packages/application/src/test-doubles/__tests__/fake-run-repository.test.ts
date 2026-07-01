import { describe, expect, it } from 'vitest';
import { RepositoryId, createRun } from '@ai-sdlc/domain';
import { FakeRunRepository } from '../fake-run-repository.js';

describe('FakeRunRepository', () => {
  const repoA = RepositoryId('owner/repo-a');
  const repoB = RepositoryId('owner/repo-b');

  it('rejects active run insertion for the same (repoId, issueNumber)', () => {
    const repo = new FakeRunRepository();
    const run1 = createRun({
      uuid: 'uuid-1',
      displayId: 'run-1',
      repoId: repoA,
      issueNumber: 42,
      startedAt: new Date('2026-07-01T00:00:00Z'),
    });
    const run2 = createRun({
      uuid: 'uuid-2',
      displayId: 'run-2',
      repoId: repoA,
      issueNumber: 42,
      startedAt: new Date('2026-07-01T01:00:00Z'),
    });

    repo.insertIfNoActive(run1);
    expect(() => repo.insertIfNoActive(run2)).toThrow('An active run already exists for issue 42');
  });

  it('permits active run insertion for the same issue number in different repositories', () => {
    const repo = new FakeRunRepository();
    const run1 = createRun({
      uuid: 'uuid-1',
      displayId: 'run-1',
      repoId: repoA,
      issueNumber: 42,
      startedAt: new Date('2026-07-01T00:00:00Z'),
    });
    const run2 = createRun({
      uuid: 'uuid-2',
      displayId: 'run-2',
      repoId: repoB,
      issueNumber: 42,
      startedAt: new Date('2026-07-01T01:00:00Z'),
    });

    repo.insertIfNoActive(run1);
    expect(() => repo.insertIfNoActive(run2)).not.toThrow();
    expect(repo.runs.size).toBe(2);
  });

  it('permits active run insertion if existing run is terminal', () => {
    const repo = new FakeRunRepository();
    const run1 = createRun({
      uuid: 'uuid-1',
      displayId: 'run-1',
      repoId: repoA,
      issueNumber: 42,
      startedAt: new Date('2026-07-01T00:00:00Z'),
    });
    // Set run1 status to terminal
    run1.status = 'passed';
    repo.addRun(run1);

    const run2 = createRun({
      uuid: 'uuid-2',
      displayId: 'run-2',
      repoId: repoA,
      issueNumber: 42,
      startedAt: new Date('2026-07-01T01:00:00Z'),
    });

    expect(() => repo.insertIfNoActive(run2)).not.toThrow();
  });

  it('findByIssueNumber returns the latest run for the requested repoId and issueNumber', () => {
    const repo = new FakeRunRepository();
    const run1 = createRun({
      uuid: 'uuid-1',
      displayId: 'run-1',
      repoId: repoA,
      issueNumber: 42,
      startedAt: new Date('2026-07-01T00:00:00Z'),
    });
    const run2 = createRun({
      uuid: 'uuid-2',
      displayId: 'run-2',
      repoId: repoA,
      issueNumber: 42,
      startedAt: new Date('2026-07-01T01:00:00Z'),
    });
    const run3 = createRun({
      uuid: 'uuid-3',
      displayId: 'run-3',
      repoId: repoB,
      issueNumber: 42,
      startedAt: new Date('2026-07-01T02:00:00Z'),
    });

    repo.addRun(run1);
    repo.addRun(run2);
    repo.addRun(run3);

    const foundA = repo.findByIssueNumber(repoA, 42);
    expect(foundA?.uuid).toBe('uuid-2');

    const foundB = repo.findByIssueNumber(repoB, 42);
    expect(foundB?.uuid).toBe('uuid-3');
  });

  it('updateStatusByIssueNumber updates only an active run for the requested repoId and issueNumber', () => {
    const repo = new FakeRunRepository();
    const run1 = createRun({
      uuid: 'uuid-1',
      displayId: 'run-1',
      repoId: repoA,
      issueNumber: 42,
      startedAt: new Date('2026-07-01T00:00:00Z'),
    });
    const run2 = createRun({
      uuid: 'uuid-2',
      displayId: 'run-2',
      repoId: repoB,
      issueNumber: 42,
      startedAt: new Date('2026-07-01T01:00:00Z'),
    });

    repo.addRun(run1);
    repo.addRun(run2);

    const updated = repo.updateStatusByIssueNumber(repoA, 42, {
      status: 'passed',
      completedAt: new Date('2026-07-01T02:00:00Z'),
    });

    expect(updated).toBe(true);
    expect(repo.runs.get('uuid-1')?.status).toBe('passed');
    // repoB's active run should remain running
    expect(repo.runs.get('uuid-2')?.status).toBe('running');

    // Attempting to update a terminal run should fail/not match
    const secondUpdate = repo.updateStatusByIssueNumber(repoA, 42, {
      status: 'failed',
      completedAt: new Date('2026-07-01T03:00:00Z'),
    });
    expect(secondUpdate).toBe(false);
    expect(repo.runs.get('uuid-1')?.status).toBe('passed');
  });
});
