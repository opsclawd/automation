import { describe, it, expect } from 'vitest';
import {
  ReleaseBatchId,
  RepositoryId,
  createReleaseBatch,
  admitItem,
  markItemMerged,
  DuplicatePositionError,
  DuplicateIssueError,
  DuplicateRunAssignmentError,
  ReassignRunError,
  ImmutableItemMergedError,
  ReleaseBatchStateError,
} from '@ai-sdlc/domain';
import { FakeReleaseBatchRepository } from '../test-doubles/fake-release-batch-repository.js';

const t0 = new Date('2026-09-11T10:00:00.000Z');
const t1 = new Date('2026-09-11T11:00:00.000Z');
const t2 = new Date('2026-09-11T12:00:00.000Z');

function createFiveItemBatch(id = 'batch-1', repo = 'repo-1') {
  return createReleaseBatch({
    id: ReleaseBatchId(id),
    repoId: RepositoryId(repo),
    sourceBranch: 'main',
    sourceStartSha: 'start-sha-1',
    releaseBranch: `release/2026-09-11-${id}`,
    createdAt: t0,
    items: [
      { position: 1, issueNumber: 101 },
      { position: 2, issueNumber: 102 },
      { position: 3, issueNumber: 103 },
      { position: 4, issueNumber: 104 },
      { position: 5, issueNumber: 105 },
    ],
  });
}

describe('FakeReleaseBatchRepository', () => {
  it('insert + findById round-trips 5 ordered items losslessly as a deep clone', () => {
    const repo = new FakeReleaseBatchRepository();
    const batch = createFiveItemBatch();
    repo.insert(batch);

    const retrieved = repo.findById(ReleaseBatchId('batch-1'));
    expect(retrieved).toBeDefined();
    expect(retrieved).toEqual(batch);
    expect(retrieved).not.toBe(batch);
    expect(retrieved!.items[0]).not.toBe(batch.items[0]);
  });

  it('mutating returned object does not corrupt stored state', () => {
    const repo = new FakeReleaseBatchRepository();
    const batch = createFiveItemBatch();
    repo.insert(batch);

    const got = repo.findById(ReleaseBatchId('batch-1'))!;
    got.status = 'cancelled';
    got.items[0]!.status = 'merged';

    const clean = repo.findById(ReleaseBatchId('batch-1'))!;
    expect(clean.status).toBe('queued');
    expect(clean.items[0]!.status).toBe('pending');
  });

  it('update modifies batch and item state', () => {
    const repo = new FakeReleaseBatchRepository();
    let batch = createFiveItemBatch();
    repo.insert(batch);

    batch = admitItem(batch, 1, { runUuid: 'run-1', baseSha: 'base-sha-1', now: t1 });
    batch = markItemMerged(batch, 1, { mergedCommitSha: 'merged-sha-1', now: t2 });
    repo.update(batch);

    const updated = repo.findById(ReleaseBatchId('batch-1'))!;
    expect(updated.status).toBe('building');
    expect(updated.items[0]!.status).toBe('merged');
    expect(updated.items[0]!.runUuid).toBe('run-1');
    expect(updated.items[0]!.mergedCommitSha).toBe('merged-sha-1');
  });

  it('update rejects reassigning Run UUID on an item', () => {
    const repo = new FakeReleaseBatchRepository();
    let batch = createFiveItemBatch();
    batch = admitItem(batch, 1, { runUuid: 'run-1', now: t1 });
    repo.insert(batch);

    const modified = {
      ...batch,
      items: batch.items.map((i) => (i.position === 1 ? { ...i, runUuid: 'run-different' } : i)),
    };

    expect(() => repo.update(modified)).toThrow(ReassignRunError);
  });

  it('update rejects unmerging an item (merged is irreversible)', () => {
    const repo = new FakeReleaseBatchRepository();
    let batch = createFiveItemBatch();
    batch = admitItem(batch, 1, { runUuid: 'run-1', now: t1 });
    batch = markItemMerged(batch, 1, { mergedCommitSha: 'm-sha', now: t2 });
    repo.insert(batch);

    const modified = {
      ...batch,
      items: batch.items.map((i) => (i.position === 1 ? { ...i, status: 'active' as const } : i)),
    };

    expect(() => repo.update(modified)).toThrow(ImmutableItemMergedError);
  });

  it('update rejects reordering or changing positions', () => {
    const repo = new FakeReleaseBatchRepository();
    const batch = createFiveItemBatch();
    repo.insert(batch);

    const modified = {
      ...batch,
      items: [
        { ...batch.items[0]!, position: 2 },
        { ...batch.items[1]!, position: 1 },
        ...batch.items.slice(2),
      ],
    };

    expect(() => repo.update(modified)).toThrow(ReleaseBatchStateError);
  });

  it('update rejects changing issue numbers', () => {
    const repo = new FakeReleaseBatchRepository();
    const batch = createFiveItemBatch();
    repo.insert(batch);

    const modified = {
      ...batch,
      items: [{ ...batch.items[0]!, issueNumber: 999 }, ...batch.items.slice(1)],
    };

    expect(() => repo.update(modified)).toThrow(ReleaseBatchStateError);
  });

  it('rejects inserting duplicate position in items', () => {
    const repo = new FakeReleaseBatchRepository();
    const batch = createFiveItemBatch();
    const invalidBatch = {
      ...batch,
      items: [
        { ...batch.items[0]!, position: 1 },
        { ...batch.items[1]!, position: 1 },
      ],
    };

    expect(() => repo.insert(invalidBatch)).toThrow(DuplicatePositionError);
  });

  it('rejects inserting duplicate issue numbers in items', () => {
    const repo = new FakeReleaseBatchRepository();
    const batch = createFiveItemBatch();
    const invalidBatch = {
      ...batch,
      items: [
        { ...batch.items[0]!, position: 1, issueNumber: 101 },
        { ...batch.items[1]!, position: 2, issueNumber: 101 },
      ],
    };

    expect(() => repo.insert(invalidBatch)).toThrow(DuplicateIssueError);
  });

  it('rejects attaching the same run UUID across multiple items even in different batches', () => {
    const repo = new FakeReleaseBatchRepository();
    let batch1 = createFiveItemBatch('batch-1');
    batch1 = admitItem(batch1, 1, { runUuid: 'run-shared', now: t1 });
    repo.insert(batch1);

    let batch2 = createFiveItemBatch('batch-2');
    batch2 = admitItem(batch2, 1, { runUuid: 'run-shared', now: t1 });

    expect(() => repo.insert(batch2)).toThrow(DuplicateRunAssignmentError);
  });

  it('findByReleaseBranch finds the release batch by branch name', () => {
    const repo = new FakeReleaseBatchRepository();
    const batch = createFiveItemBatch('batch-1', 'repo-1');
    repo.insert(batch);

    const found = repo.findByReleaseBranch(RepositoryId('repo-1'), 'release/2026-09-11-batch-1');
    expect(found).toBeDefined();
    expect(found!.id).toBe('batch-1');

    expect(repo.findByReleaseBranch(RepositoryId('repo-1'), 'release/other')).toBeUndefined();
    expect(
      repo.findByReleaseBranch(RepositoryId('repo-other'), 'release/2026-09-11-batch-1'),
    ).toBeUndefined();
  });

  it('findByRunUuid finds the release batch and item by run UUID', () => {
    const repo = new FakeReleaseBatchRepository();
    let batch = createFiveItemBatch('batch-1');
    batch = admitItem(batch, 1, { runUuid: 'run-target', now: t1 });
    repo.insert(batch);

    const res = repo.findByRunUuid('run-target');
    expect(res).toBeDefined();
    expect(res!.batch.id).toBe('batch-1');
    expect(res!.item.position).toBe(1);
    expect(res!.item.runUuid).toBe('run-target');

    expect(repo.findByRunUuid('non-existent')).toBeUndefined();
  });

  it('listForRepo returns batches for repo ordered by createdAt DESC', () => {
    const repo = new FakeReleaseBatchRepository();
    const b1 = createReleaseBatch({
      id: ReleaseBatchId('b1'),
      repoId: RepositoryId('repo-A'),
      sourceBranch: 'main',
      sourceStartSha: 'sha1',
      releaseBranch: 'release/b1',
      createdAt: new Date('2026-09-11T09:00:00.000Z'),
      items: [{ position: 1, issueNumber: 1 }],
    });
    const b2 = createReleaseBatch({
      id: ReleaseBatchId('b2'),
      repoId: RepositoryId('repo-A'),
      sourceBranch: 'main',
      sourceStartSha: 'sha2',
      releaseBranch: 'release/b2',
      createdAt: new Date('2026-09-11T11:00:00.000Z'),
      items: [{ position: 1, issueNumber: 2 }],
    });
    const b3 = createReleaseBatch({
      id: ReleaseBatchId('b3'),
      repoId: RepositoryId('repo-B'),
      sourceBranch: 'main',
      sourceStartSha: 'sha3',
      releaseBranch: 'release/b3',
      createdAt: new Date('2026-09-11T10:00:00.000Z'),
      items: [{ position: 1, issueNumber: 3 }],
    });

    repo.insert(b1);
    repo.insert(b2);
    repo.insert(b3);

    const repoABatches = repo.listForRepo(RepositoryId('repo-A'));
    expect(repoABatches.map((b) => b.id)).toEqual(['b2', 'b1']);

    const repoBBatches = repo.listForRepo(RepositoryId('repo-B'));
    expect(repoBBatches.map((b) => b.id)).toEqual(['b3']);
  });
});
