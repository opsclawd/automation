import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RepositoryId } from '@ai-sdlc/domain';
import Database from 'better-sqlite3';
import { openDatabase, applyMigrations } from '../../index.js';
import { RunRepository, RunRepository as SqliteRunRepository } from '../run-repository.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-db-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  applyMigrations(db);
  return db;
}

describe('RunRepository', () => {
  it('inserts and reads a run round-trip', () => {
    const db = freshDb();
    const repo = new RunRepository(db);
    repo.insert({
      uuid: 'u1',
      displayId: 'issue-1-20260513-000000',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 1,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });
    const found = repo.findByUuid('u1');
    expect(found?.displayId).toBe('issue-1-20260513-000000');
    expect(found?.status).toBe('running');
    expect(found?.repoId).toBe('owner/repo');
    expect(found?.exitCode).toBeUndefined();
    expect(found?.durationMs).toBeUndefined();
    db.close();
  });

  it('lists runs ordered by startedAt desc (no params → all)', () => {
    const db = freshDb();
    const repo = new RunRepository(db);
    for (let i = 1; i <= 3; i++) {
      repo.insert({
        uuid: `u${i}`,
        displayId: `issue-${i}-20260513-00000${i}`,
        repoId: RepositoryId('owner/repo'),
        issueNumber: i,
        type: 'issue_to_pr',
        status: 'running',
        completedPhases: [],
        startedAt: new Date(`2026-05-13T00:00:0${i}Z`),
      });
    }
    const { runs } = repo.list();
    expect(runs.map((r) => r.uuid)).toEqual(['u3', 'u2', 'u1']);
    db.close();
  });

  it('list({ limit: 2, offset: 1 }) returns correct slice and total', () => {
    const db = freshDb();
    const repo = new RunRepository(db);
    for (let i = 1; i <= 5; i++) {
      repo.insert({
        uuid: `u${i}`,
        displayId: `issue-${i}-20260513-00000${i}`,
        repoId: RepositoryId('owner/repo'),
        issueNumber: i,
        type: 'issue_to_pr',
        status: 'running',
        completedPhases: [],
        startedAt: new Date(`2026-05-13T00:00:0${i}Z`),
      });
    }
    const { runs, total } = repo.list({ limit: 2, offset: 1 });
    expect(runs.map((r) => r.uuid)).toEqual(['u4', 'u3']);
    expect(total).toBe(5);
    db.close();
  });

  it('updates status, exitCode, durationMs, failureReason', () => {
    const db = freshDb();
    const repo = new RunRepository(db);
    repo.insert({
      uuid: 'u',
      displayId: 'issue-1-20260513-000000',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 1,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });
    repo.update('u', {
      status: 'failed',
      exitCode: 2,
      durationMs: 1500,
      failureReason: 'boom',
    });
    const got = repo.findByUuid('u');
    expect(got?.status).toBe('failed');
    expect(got?.exitCode).toBe(2);
    expect(got?.durationMs).toBe(1500);
    expect(got?.failureReason).toBe('boom');
    db.close();
  });

  it('refuses to create a second active run for the same issue', () => {
    const db = freshDb();
    const repo = new RunRepository(db);
    repo.insert({
      uuid: 'a',
      displayId: 'issue-1-20260513-000000',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 1,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });
    expect(() =>
      repo.insertIfNoActive({
        uuid: 'b',
        displayId: 'issue-1-20260513-000001',
        repoId: RepositoryId('owner/repo'),
        issueNumber: 1,
        type: 'issue_to_pr',
        status: 'running',
        completedPhases: [],
        startedAt: new Date('2026-05-13T00:00:01Z'),
      }),
    ).toThrow(/active run/i);
    db.close();
  });

  it('allows a second run when first is in terminal status', () => {
    const db = freshDb();
    const repo = new RunRepository(db);
    repo.insert({
      uuid: 'a',
      displayId: 'issue-1-20260513-000000',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 1,
      type: 'issue_to_pr',
      status: 'passed',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });
    expect(() =>
      repo.insertIfNoActive({
        uuid: 'b',
        displayId: 'issue-1-20260513-000001',
        repoId: RepositoryId('owner/repo'),
        issueNumber: 1,
        type: 'issue_to_pr',
        status: 'running',
        completedPhases: [],
        startedAt: new Date('2026-05-13T00:00:01Z'),
      }),
    ).not.toThrow();
    db.close();
  });

  it('records pid on insert', () => {
    const db = freshDb();
    const repo = new RunRepository(db);
    repo.insert(
      {
        uuid: 'u1',
        displayId: 'issue-1-20260513-000000',
        repoId: RepositoryId('owner/repo'),
        issueNumber: 1,
        type: 'issue_to_pr',
        status: 'running',
        completedPhases: [],
        startedAt: new Date('2026-05-13T00:00:00Z'),
      },
      12345,
    );
    const found = repo.findByUuid('u1');
    expect(found?.pid).toBe(12345);
    db.close();
  });

  it('findByIssueNumber returns latest run for an issue', () => {
    const db = freshDb();
    const repo = new RunRepository(db);
    repo.insert({
      uuid: 'u1',
      displayId: 'issue-1-20260513-000000',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 1,
      type: 'issue_to_pr',
      status: 'passed',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });
    repo.insert({
      uuid: 'u2',
      displayId: 'issue-1-20260513-000001',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 1,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T01:00:00Z'),
    });
    const found = repo.findByIssueNumber(RepositoryId('owner/repo'), 1);
    expect(found?.uuid).toBe('u2');
    db.close();
  });

  it('findActiveRuns returns only non-terminal runs', () => {
    const db = freshDb();
    const repo = new RunRepository(db);
    repo.insert({
      uuid: 'u1',
      displayId: 'issue-1-20260513-000000',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 1,
      type: 'issue_to_pr',
      status: 'passed',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });
    repo.insert({
      uuid: 'u2',
      displayId: 'issue-2-20260513-000000',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 2,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });
    repo.insert({
      uuid: 'u3',
      displayId: 'issue-3-20260513-000000',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 3,
      type: 'issue_to_pr',
      status: 'waiting',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:01Z'),
    });
    const active = repo.findActiveRuns();
    expect(active.map((r) => r.uuid)).toEqual(['u2', 'u3']);
    db.close();
  });

  it('updateStatusByIssueNumber updates and returns true for active run', () => {
    const db = freshDb();
    const repo = new RunRepository(db);
    repo.insert({
      uuid: 'u1',
      displayId: 'issue-5-20260513-000000',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 5,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });
    const updated = repo.updateStatusByIssueNumber(RepositoryId('owner/repo'), 5, {
      status: 'cancelled',
      completedAt: new Date('2026-05-13T01:00:00Z'),
      failureReason: 'test',
    });
    expect(updated).toBe(true);
    const row = repo.findByIssueNumber(RepositoryId('owner/repo'), 5);
    expect(row?.status).toBe('cancelled');
    expect(row?.failureReason).toBe('test');
    db.close();
  });

  it('updateStatusByIssueNumber returns false for terminal run', () => {
    const db = freshDb();
    const repo = new RunRepository(db);
    repo.insert({
      uuid: 'u1',
      displayId: 'issue-6-20260513-000000',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 6,
      type: 'issue_to_pr',
      status: 'passed',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });
    const updated = repo.updateStatusByIssueNumber(RepositoryId('owner/repo'), 6, {
      status: 'cancelled',
      completedAt: new Date('2026-05-13T01:00:00Z'),
    });
    expect(updated).toBe(false);
    db.close();
  });

  it('updateStatusByUuid updates and returns true for active run', () => {
    const db = freshDb();
    const repo = new RunRepository(db);
    repo.insert({
      uuid: 'u1',
      displayId: 'issue-7-20260513-000000',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 7,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });
    const updated = repo.updateStatusByUuid('u1', {
      status: 'cancelled',
      completedAt: new Date('2026-05-13T01:00:00Z'),
      failureReason: 'test',
    });
    expect(updated).toBe(true);
    const row = repo.findByUuid('u1');
    expect(row?.status).toBe('cancelled');
    expect(row?.failureReason).toBe('test');
    db.close();
  });

  it('updateStatusByUuid clears currentPhase when set to null in patch', () => {
    const db = freshDb();
    const repo = new RunRepository(db);
    repo.insert({
      uuid: 'u1',
      displayId: 'issue-7-20260513-000000',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 7,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      currentPhase: 'implement',
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });
    const updated = repo.updateStatusByUuid('u1', {
      status: 'failed',
      completedAt: new Date('2026-05-13T01:00:00Z'),
      currentPhase: null,
    });
    expect(updated).toBe(true);
    const row = repo.findByUuid('u1');
    expect(row?.status).toBe('failed');
    expect(row?.currentPhase).toBeUndefined();
    db.close();
  });

  it('updateStatusByUuid returns false for terminal run', () => {
    const db = freshDb();
    const repo = new RunRepository(db);
    repo.insert({
      uuid: 'u1',
      displayId: 'issue-8-20260513-000000',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 8,
      type: 'issue_to_pr',
      status: 'passed',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });
    const updated = repo.updateStatusByUuid('u1', {
      status: 'cancelled',
      completedAt: new Date('2026-05-13T01:00:00Z'),
    });
    expect(updated).toBe(false);
    db.close();
  });

  it('atomicUpdateByUuid returns true when expectedStatus matches', () => {
    const db = freshDb();
    const repo = new RunRepository(db);
    repo.insert({
      uuid: 'u1',
      displayId: 'issue-9-20260513-000000',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 9,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });
    const updated = repo.atomicUpdateByUuid('u1', { status: 'failed' }, 'running');
    expect(updated).toBe(true);
    const row = repo.findByUuid('u1');
    expect(row?.status).toBe('failed');
    db.close();
  });

  it('atomicUpdateByUuid returns false when expectedStatus does not match', () => {
    const db = freshDb();
    const repo = new RunRepository(db);
    repo.insert({
      uuid: 'u1',
      displayId: 'issue-10-20260513-000000',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 10,
      type: 'issue_to_pr',
      status: 'passed',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });
    const updated = repo.atomicUpdateByUuid('u1', { status: 'failed' }, 'running');
    expect(updated).toBe(false);
    db.close();
  });

  it('atomicUpdateByUuid does not modify row on status mismatch', () => {
    const db = freshDb();
    const repo = new RunRepository(db);
    repo.insert({
      uuid: 'u1',
      displayId: 'issue-11-20260513-000000',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 11,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });
    repo.atomicUpdateByUuid('u1', { status: 'failed' }, 'cancelled');
    const row = repo.findByUuid('u1');
    expect(row?.status).toBe('running');
    db.close();
  });

  it('enforces active uniqueness scoped to repoId and issueNumber', () => {
    const db = freshDb();
    const repo = new RunRepository(db);
    const repoA = RepositoryId('owner/repo-a');
    const repoB = RepositoryId('owner/repo-b');

    // Insert active run for issue 1 in repo A
    repo.insert({
      uuid: 'u1',
      displayId: 'issue-1-repo-a',
      repoId: repoA,
      issueNumber: 1,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });

    // Inserting another active run for issue 1 in SAME repo (repo A) should throw
    expect(() =>
      repo.insertIfNoActive({
        uuid: 'u2',
        displayId: 'issue-1-repo-a-2',
        repoId: repoA,
        issueNumber: 1,
        type: 'issue_to_pr',
        status: 'running',
        completedPhases: [],
        startedAt: new Date('2026-05-13T00:00:01Z'),
      }),
    ).toThrow(/active run/i);

    // Inserting active run for issue 1 in DIFFERENT repo (repo B) should succeed
    expect(() =>
      repo.insertIfNoActive({
        uuid: 'u3',
        displayId: 'issue-1-repo-b',
        repoId: repoB,
        issueNumber: 1,
        type: 'issue_to_pr',
        status: 'running',
        completedPhases: [],
        startedAt: new Date('2026-05-13T00:00:02Z'),
      }),
    ).not.toThrow();

    db.close();
  });

  it('proves findByIssueNumber and updateStatusByIssueNumber do not cross repository boundaries', () => {
    const db = freshDb();
    const repo = new RunRepository(db);
    const repoA = RepositoryId('owner/repo-a');
    const repoB = RepositoryId('owner/repo-b');

    repo.insert({
      uuid: 'ua',
      displayId: 'issue-42-repo-a',
      repoId: repoA,
      issueNumber: 42,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });

    repo.insert({
      uuid: 'ub',
      displayId: 'issue-42-repo-b',
      repoId: repoB,
      issueNumber: 42,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:01Z'),
    });

    // findByIssueNumber for repo A finds repo A's run, not repo B's
    const foundA = repo.findByIssueNumber(repoA, 42);
    expect(foundA?.uuid).toBe('ua');

    const foundB = repo.findByIssueNumber(repoB, 42);
    expect(foundB?.uuid).toBe('ub');

    // updateStatusByIssueNumber for repo A only updates repo A
    const updated = repo.updateStatusByIssueNumber(repoA, 42, {
      status: 'passed',
      completedAt: new Date('2026-05-13T02:00:00Z'),
    });
    expect(updated).toBe(true);

    // repo A's run is now passed
    expect(repo.findByIssueNumber(repoA, 42)?.status).toBe('passed');
    // repo B's run remains running
    expect(repo.findByIssueNumber(repoB, 42)?.status).toBe('running');

    db.close();
  });

  it('persists and reads baseBranch on runs', () => {
    const db = freshDb();
    const repo = new RunRepository(db);
    repo.insert({
      uuid: 'u-bb',
      displayId: 'issue-100-bb',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 100,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
      baseBranch: 'main-branch',
    });

    const found = repo.findByUuid('u-bb');
    expect(found?.baseBranch).toBe('main-branch');

    // Test update
    repo.update('u-bb', { baseBranch: 'another-branch' });
    const updated = repo.findByUuid('u-bb');
    expect(updated?.baseBranch).toBe('another-branch');

    // Test atomicUpdateByUuid
    repo.atomicUpdateByUuid('u-bb', { baseBranch: 'atomic-branch' }, 'running');
    const atomic = repo.findByUuid('u-bb');
    expect(atomic?.baseBranch).toBe('atomic-branch');

    db.close();
  });

  it('persists and retrieves config fingerprint and sources JSON', () => {
    const db = freshDb();
    const fingerprint = 'test-fingerprint-12345';
    const sourcesJson = JSON.stringify([{ path: 'test-path', kind: 'automation', present: true }]);

    const repo = new RunRepository(db, fingerprint, sourcesJson);
    repo.insert({
      uuid: 'u-config',
      displayId: 'issue-101-config',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 101,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });

    const found = repo.findByUuid('u-config');
    expect(found?.configFingerprint).toBe(fingerprint);
    expect(found?.configSourcesJson).toBe(sourcesJson);

    // Test updates
    const nextFingerprint = 'test-fingerprint-updated';
    const nextSourcesJson = JSON.stringify([
      { path: 'test-path-2', kind: 'local', present: false },
    ]);
    repo.update('u-config', {
      configFingerprint: nextFingerprint,
      configSourcesJson: nextSourcesJson,
    });

    const updated = repo.findByUuid('u-config');
    expect(updated?.configFingerprint).toBe(nextFingerprint);
    expect(updated?.configSourcesJson).toBe(nextSourcesJson);

    // Test atomicUpdateByUuid
    const atomicFingerprint = 'test-fingerprint-atomic';
    repo.atomicUpdateByUuid('u-config', { configFingerprint: atomicFingerprint }, 'running');
    const atomic = repo.findByUuid('u-config');
    expect(atomic?.configFingerprint).toBe(atomicFingerprint);

    db.close();
  });
});

describe('SqliteRunRepository.list filtering', () => {
  function makeDb() {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE runs (
        uuid TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        issue_number INTEGER
      );
      CREATE INDEX idx_runs_repo_id_issue_number ON runs(repo_id, issue_number);
    `);
    return db;
  }

  it('filters by repositoryId and status', () => {
    const db = makeDb();
    const repo = new SqliteRunRepository(
      db as unknown as Parameters<typeof SqliteRunRepository>[0],
    );
    const idA = 'a'.repeat(64);
    const idB = 'b'.repeat(64);
    db.prepare(`INSERT INTO runs (uuid, repo_id, status, started_at) VALUES (?, ?, ?, ?)`).run(
      'u1',
      idA,
      'completed',
      1,
    );
    db.prepare(`INSERT INTO runs (uuid, repo_id, status, started_at) VALUES (?, ?, ?, ?)`).run(
      'u2',
      idA,
      'failed',
      2,
    );
    db.prepare(`INSERT INTO runs (uuid, repo_id, status, started_at) VALUES (?, ?, ?, ?)`).run(
      'u3',
      idB,
      'failed',
      3,
    );

    const aRuns = repo.list({ limit: 50, repositoryId: RepositoryId(idA) });
    expect(aRuns.runs.map((r) => r.uuid)).toEqual(['u2', 'u1']);
    expect(aRuns.total).toBe(2);

    const failed = repo.list({ limit: 50, status: 'failed' });
    expect(failed.runs.map((r) => r.uuid).sort()).toEqual(['u2', 'u3']);
    expect(failed.total).toBe(2);

    const both = repo.list({ limit: 50, repositoryId: RepositoryId(idA), status: 'failed' });
    expect(both.runs.map((r) => r.uuid)).toEqual(['u2']);
    expect(both.total).toBe(1);
  });
});
