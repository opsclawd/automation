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
});
