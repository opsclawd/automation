import { describe, it, expect } from 'vitest';
import {
  ReleaseBatchId,
  RepositoryId,
  createReleaseBatch,
  admitItem,
  markItemMerged,
  ReassignRunError,
  ImmutableItemMergedError,
  ReleaseBatchStateError,
} from '@ai-sdlc/domain';
import { openDatabase, applyMigrations } from '../../index.js';
import { ReleaseBatchRepository } from '../release-batch-repository.js';

const t0 = new Date('2026-09-11T10:00:00.000Z');
const t1 = new Date('2026-09-11T11:00:00.000Z');
const t2 = new Date('2026-09-11T12:00:00.000Z');

function setup() {
  const db = openDatabase(':memory:');
  applyMigrations(db);
  return { db, repo: new ReleaseBatchRepository(db) };
}

function createFiveItemBatch(id = 'batch-1', repo = 'repo-1') {
  return createReleaseBatch({
    id: ReleaseBatchId(id),
    repoId: RepositoryId(repo),
    sourceBranch: 'main',
    sourceStartSha: 'start-sha-1234567890abcdef1234567890abcdef',
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

describe('ReleaseBatchRepository (SQLite)', () => {
  it('round-trips a ReleaseBatch with at least five ordered items through SQLite exactly', () => {
    const { db, repo } = setup();

    let batch = createFiveItemBatch();
    batch = admitItem(batch, 1, { runUuid: 'run-1', baseSha: 'base-1', now: t1 });
    batch = markItemMerged(batch, 1, { mergedCommitSha: 'commit-m1', now: t2 });
    batch = admitItem(batch, 2, { runUuid: 'run-2', baseSha: 'base-2', now: t2 });

    repo.insert(batch);

    const retrieved = repo.findById(ReleaseBatchId('batch-1'));
    expect(retrieved).toBeDefined();
    expect(retrieved).toEqual(batch);
    expect(retrieved!.items).toHaveLength(5);
    expect(retrieved!.items[0]!.status).toBe('merged');
    expect(retrieved!.items[0]!.runUuid).toBe('run-1');
    expect(retrieved!.items[0]!.mergedCommitSha).toBe('commit-m1');
    expect(retrieved!.items[0]!.completedAt).toEqual(t2);
    expect(retrieved!.items[1]!.status).toBe('active');
    expect(retrieved!.items[1]!.runUuid).toBe('run-2');
    expect(retrieved!.items[2]!.status).toBe('pending');
    expect(retrieved!.items[3]!.status).toBe('pending');
    expect(retrieved!.items[4]!.status).toBe('pending');

    db.close();
  });

  it('rejects duplicate (release_batch_id, position)', () => {
    const { db } = setup();

    db.prepare(
      `INSERT INTO release_batches
        (id, repo_id, source_branch, source_start_sha, release_branch, status, current_position, created_at)
       VALUES ('b1', 'repo-1', 'main', 'sha1', 'rel1', 'queued', 1, '2026-09-11T10:00:00.000Z')`,
    ).run();

    db.prepare(
      `INSERT INTO release_batch_items (release_batch_id, position, issue_number, status)
       VALUES ('b1', 1, 101, 'pending')`,
    ).run();

    expect(() => {
      db.prepare(
        `INSERT INTO release_batch_items (release_batch_id, position, issue_number, status)
         VALUES ('b1', 1, 102, 'pending')`,
      ).run();
    }).toThrow(
      /UNIQUE constraint failed: release_batch_items\.release_batch_id, release_batch_items\.position/,
    );

    db.close();
  });

  it('rejects duplicate issue number within the same release batch', () => {
    const { db } = setup();

    db.prepare(
      `INSERT INTO release_batches
        (id, repo_id, source_branch, source_start_sha, release_branch, status, current_position, created_at)
       VALUES ('b1', 'repo-1', 'main', 'sha1', 'rel1', 'queued', 1, '2026-09-11T10:00:00.000Z')`,
    ).run();

    db.prepare(
      `INSERT INTO release_batch_items (release_batch_id, position, issue_number, status)
       VALUES ('b1', 1, 101, 'pending')`,
    ).run();

    expect(() => {
      db.prepare(
        `INSERT INTO release_batch_items (release_batch_id, position, issue_number, status)
         VALUES ('b1', 2, 101, 'pending')`,
      ).run();
    }).toThrow(/UNIQUE constraint failed/);

    db.close();
  });

  it('rejects attaching the same run UUID to multiple items', () => {
    const { db, repo } = setup();

    let batch1 = createFiveItemBatch('b1');
    batch1 = admitItem(batch1, 1, { runUuid: 'run-unique-123', now: t1 });
    repo.insert(batch1);

    let batch2 = createFiveItemBatch('b2');
    batch2 = admitItem(batch2, 1, { runUuid: 'run-unique-123', now: t1 });

    expect(() => repo.insert(batch2)).toThrow(
      /UNIQUE constraint failed: release_batch_items\.run_uuid/,
    );

    db.close();
  });

  it("rejects reassigning an item's run UUID on update", () => {
    const { db, repo } = setup();

    let batch = createFiveItemBatch();
    batch = admitItem(batch, 1, { runUuid: 'run-original', now: t1 });
    repo.insert(batch);

    const tampered = {
      ...batch,
      items: batch.items.map((i) => (i.position === 1 ? { ...i, runUuid: 'run-tampered' } : i)),
    };

    expect(() => repo.update(tampered)).toThrow(ReassignRunError);

    db.close();
  });

  it('rejects unmerging an item on update (merged is irreversible)', () => {
    const { db, repo } = setup();

    let batch = createFiveItemBatch();
    batch = admitItem(batch, 1, { runUuid: 'run-1', now: t1 });
    batch = markItemMerged(batch, 1, { mergedCommitSha: 'sha-m', now: t2 });
    repo.insert(batch);

    const tampered = {
      ...batch,
      items: batch.items.map((i) => (i.position === 1 ? { ...i, status: 'active' as const } : i)),
    };

    expect(() => repo.update(tampered)).toThrow(ImmutableItemMergedError);

    db.close();
  });

  it('rejects reordering or modifying item positions on update', () => {
    const { db, repo } = setup();

    const batch = createFiveItemBatch();
    repo.insert(batch);

    const tampered = {
      ...batch,
      items: [
        { ...batch.items[0]!, position: 2 },
        { ...batch.items[1]!, position: 1 },
        ...batch.items.slice(2),
      ],
    };

    expect(() => repo.update(tampered)).toThrow(ReleaseBatchStateError);

    db.close();
  });

  it('findByReleaseBranch finds the batch by repo ID and branch name', () => {
    const { db, repo } = setup();
    const batch = createFiveItemBatch('b1', 'repo-xyz');
    repo.insert(batch);

    const found = repo.findByReleaseBranch(RepositoryId('repo-xyz'), 'release/2026-09-11-b1');
    expect(found).toBeDefined();
    expect(found!.id).toBe('b1');

    expect(
      repo.findByReleaseBranch(RepositoryId('repo-xyz'), 'release/non-existent'),
    ).toBeUndefined();
    expect(
      repo.findByReleaseBranch(RepositoryId('other-repo'), 'release/2026-09-11-b1'),
    ).toBeUndefined();

    db.close();
  });

  it('findByRunUuid finds the batch and item by Run UUID', () => {
    const { db, repo } = setup();
    let batch = createFiveItemBatch('b1');
    batch = admitItem(batch, 1, { runUuid: 'run-target-uuid', now: t1 });
    repo.insert(batch);

    const res = repo.findByRunUuid('run-target-uuid');
    expect(res).toBeDefined();
    expect(res!.batch.id).toBe('b1');
    expect(res!.item.position).toBe(1);
    expect(res!.item.runUuid).toBe('run-target-uuid');

    expect(repo.findByRunUuid('does-not-exist')).toBeUndefined();

    db.close();
  });

  it('listForRepo returns all batches for a repository ordered by createdAt DESC', () => {
    const { db, repo } = setup();

    const b1 = createReleaseBatch({
      id: ReleaseBatchId('b1'),
      repoId: RepositoryId('repo-alpha'),
      sourceBranch: 'main',
      sourceStartSha: 'sha1',
      releaseBranch: 'release/b1',
      createdAt: new Date('2026-09-11T08:00:00.000Z'),
      items: [{ position: 1, issueNumber: 1 }],
    });
    const b2 = createReleaseBatch({
      id: ReleaseBatchId('b2'),
      repoId: RepositoryId('repo-alpha'),
      sourceBranch: 'main',
      sourceStartSha: 'sha2',
      releaseBranch: 'release/b2',
      createdAt: new Date('2026-09-11T12:00:00.000Z'),
      items: [{ position: 1, issueNumber: 2 }],
    });
    const b3 = createReleaseBatch({
      id: ReleaseBatchId('b3'),
      repoId: RepositoryId('repo-beta'),
      sourceBranch: 'main',
      sourceStartSha: 'sha3',
      releaseBranch: 'release/b3',
      createdAt: new Date('2026-09-11T10:00:00.000Z'),
      items: [{ position: 1, issueNumber: 3 }],
    });

    repo.insert(b1);
    repo.insert(b2);
    repo.insert(b3);

    const alphaBatches = repo.listForRepo(RepositoryId('repo-alpha'));
    expect(alphaBatches).toHaveLength(2);
    expect(alphaBatches.map((b) => b.id)).toEqual(['b2', 'b1']);

    const betaBatches = repo.listForRepo(RepositoryId('repo-beta'));
    expect(betaBatches).toHaveLength(1);
    expect(betaBatches[0]!.id).toBe('b3');

    db.close();
  });
});
