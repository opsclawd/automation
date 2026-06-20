import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, applyMigrations } from '../../index.js';
import { RunRepository } from '../run-repository.js';

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
      issueNumber: 1,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });
    const found = repo.findByUuid('u1');
    expect(found?.displayId).toBe('issue-1-20260513-000000');
    expect(found?.status).toBe('running');
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
      issueNumber: 1,
      type: 'issue_to_pr',
      status: 'passed',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });
    repo.insert({
      uuid: 'u2',
      displayId: 'issue-1-20260513-000001',
      issueNumber: 1,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T01:00:00Z'),
    });
    const found = repo.findByIssueNumber(1);
    expect(found?.uuid).toBe('u2');
    db.close();
  });

  it('findActiveRuns returns only non-terminal runs', () => {
    const db = freshDb();
    const repo = new RunRepository(db);
    repo.insert({
      uuid: 'u1',
      displayId: 'issue-1-20260513-000000',
      issueNumber: 1,
      type: 'issue_to_pr',
      status: 'passed',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });
    repo.insert({
      uuid: 'u2',
      displayId: 'issue-2-20260513-000000',
      issueNumber: 2,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });
    repo.insert({
      uuid: 'u3',
      displayId: 'issue-3-20260513-000000',
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
      issueNumber: 5,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });
    const updated = repo.updateStatusByIssueNumber(5, {
      status: 'cancelled',
      completedAt: new Date('2026-05-13T01:00:00Z'),
      failureReason: 'test',
    });
    expect(updated).toBe(true);
    const row = repo.findByIssueNumber(5);
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
      issueNumber: 6,
      type: 'issue_to_pr',
      status: 'passed',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });
    const updated = repo.updateStatusByIssueNumber(6, {
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

  it('updateStatusByUuid returns false for terminal run', () => {
    const db = freshDb();
    const repo = new RunRepository(db);
    repo.insert({
      uuid: 'u1',
      displayId: 'issue-8-20260513-000000',
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
});
