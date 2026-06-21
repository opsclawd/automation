import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, applyMigrations } from '../../index.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-m13-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  applyMigrations(db);
  return db;
}

describe('migration 0013 — worker_leases table', () => {
  it('creates the worker_leases table with expected columns', () => {
    const db = freshDb();
    const columns = db.prepare(`PRAGMA table_info(worker_leases)`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    const byName = Object.fromEntries(columns.map((c) => [c.name, c]));
    expect(byName['repo_id'].pk).toBe(1);
    expect(byName['worker_id'].notnull).toBe(1);
    expect(byName['run_id'].notnull).toBe(1);
    expect(byName['acquired_at'].notnull).toBe(1);
    expect(byName['heartbeat_at'].notnull).toBe(1);
    expect(byName['expires_at'].notnull).toBe(1);
    db.close();
  });

  it('enforces repo_id uniqueness at the DB level', () => {
    const db = freshDb();
    const now = new Date('2026-01-01T00:00:00Z').toISOString();
    const exp = new Date('2026-01-01T00:01:00Z').toISOString();
    db.prepare(
      `INSERT INTO worker_leases (repo_id, worker_id, run_id, acquired_at, heartbeat_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('repo-a', 'w1', 'run-1', now, now, exp);
    expect(() =>
      db
        .prepare(
          `INSERT INTO worker_leases (repo_id, worker_id, run_id, acquired_at, heartbeat_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run('repo-a', 'w2', 'run-2', now, now, exp),
    ).toThrow();
    db.close();
  });

  it('schema_version records migration 13', () => {
    const db = freshDb();
    const row = db.prepare(`SELECT version FROM schema_version WHERE version = 13`).get() as
      | { version: number }
      | undefined;
    expect(row?.version).toBe(13);
    db.close();
  });
});
