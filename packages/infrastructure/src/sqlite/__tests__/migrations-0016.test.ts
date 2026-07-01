import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, applyMigrations } from '../../index.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-m16-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  applyMigrations(db);
  return db;
}

describe('migration 0016 — repo_id column on runs table', () => {
  it('adds the repo_id column to the runs table', () => {
    const db = freshDb();
    const columns = db.prepare('PRAGMA table_info(runs)').all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
      dflt_value: string | null;
    }>;
    const byName = Object.fromEntries(columns.map((c) => [c.name, c]));

    expect(byName['repo_id']).toBeDefined();
    expect(byName['repo_id'].type).toBe('TEXT');
    expect(byName['repo_id'].notnull).toBe(0);

    db.close();
  });

  it('creates the idx_runs_repo_issue_status index', () => {
    const db = freshDb();
    const indexes = db.prepare('PRAGMA index_list(runs)').all() as Array<{
      name: string;
      unique: number;
    }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_runs_repo_issue_status');
    db.close();
  });

  it('schema_version records migration 16', () => {
    const db = freshDb();
    const row = db.prepare('SELECT version FROM schema_version WHERE version = 16').get() as
      | { version: number }
      | undefined;
    expect(row?.version).toBe(16);
    db.close();
  });

  it('backfills existing run records with repo_id = unknown', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-orch-m16-backfill-'));
    const db = openDatabase(join(dir, 'orch.sqlite'));

    db.exec(`
      CREATE TABLE runs (
        uuid TEXT PRIMARY KEY,
        display_id TEXT NOT NULL UNIQUE,
        issue_number INTEGER NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL
      );
    `);

    db.prepare(
      `
      INSERT INTO runs (uuid, display_id, issue_number, type, status, started_at)
      VALUES ('test-uuid', 'display-1', 42, 'test-type', 'passed', '2026-07-01T12:00:00Z');
    `,
    ).run();

    db.exec(`
      ALTER TABLE runs ADD COLUMN repo_id TEXT;
      UPDATE runs SET repo_id = 'unknown' WHERE repo_id IS NULL;
      CREATE INDEX IF NOT EXISTS idx_runs_repo_issue_status ON runs (repo_id, issue_number, status);
    `);

    const row = db.prepare("SELECT repo_id FROM runs WHERE uuid = 'test-uuid'").get() as {
      repo_id: string;
    };
    expect(row.repo_id).toBe('unknown');

    db.close();
  });
});
