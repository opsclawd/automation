import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, applyMigrations } from '../../index.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-m15-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  applyMigrations(db);
  return db;
}

describe('migration 0015 — jobs table', () => {
  it('creates the jobs table with expected columns and constraints', () => {
    const db = freshDb();
    const columns = db.prepare('PRAGMA table_info(jobs)').all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
      dflt_value: string | null;
    }>;
    const byName = Object.fromEntries(columns.map((c) => [c.name, c]));

    expect(byName['id'].pk).toBe(1);
    expect(byName['id'].type).toBe('TEXT');
    expect(byName['id'].notnull).toBe(0);

    expect(byName['run_id'].notnull).toBe(1);
    expect(byName['run_id'].type).toBe('TEXT');

    expect(byName['repo_id'].notnull).toBe(1);
    expect(byName['repo_id'].type).toBe('TEXT');

    expect(byName['issue_number'].notnull).toBe(1);
    expect(byName['issue_number'].type).toBe('INTEGER');

    expect(byName['status'].notnull).toBe(1);
    expect(byName['status'].type).toBe('TEXT');

    expect(byName['priority'].notnull).toBe(1);
    expect(byName['priority'].type).toBe('INTEGER');
    expect(byName['priority'].dflt_value).toBe('0');

    expect(byName['attempts'].notnull).toBe(1);
    expect(byName['attempts'].type).toBe('INTEGER');
    expect(byName['attempts'].dflt_value).toBe('0');

    expect(byName['claimed_by'].notnull).toBe(0);
    expect(byName['claimed_by'].type).toBe('TEXT');

    expect(byName['created_at'].notnull).toBe(1);
    expect(byName['created_at'].type).toBe('TEXT');

    expect(byName['claimed_at'].notnull).toBe(0);
    expect(byName['claimed_at'].type).toBe('TEXT');

    expect(byName['started_at'].notnull).toBe(0);
    expect(byName['started_at'].type).toBe('TEXT');

    expect(byName['completed_at'].notnull).toBe(0);
    expect(byName['completed_at'].type).toBe('TEXT');

    db.close();
  });

  it('creates the expected indexes', () => {
    const db = freshDb();
    const indexes = db.prepare('PRAGMA index_list(jobs)').all() as Array<{
      name: string;
      unique: number;
    }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_jobs_status_priority_created');
    expect(names).toContain('idx_jobs_repo_id');
    expect(names).toContain('idx_jobs_run_id');
    db.close();
  });

  it('schema_version records migration 15', () => {
    const db = freshDb();
    const row = db.prepare('SELECT version FROM schema_version WHERE version = 15').get() as
      | { version: number }
      | undefined;
    expect(row?.version).toBe(15);
    db.close();
  });
});
