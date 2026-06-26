import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, applyMigrations } from '../../index.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-m14-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  applyMigrations(db);
  return db;
}

describe('migration 0014 — steps table', () => {
  it('creates the steps table with expected columns and constraints', () => {
    const db = freshDb();
    const columns = db.prepare('PRAGMA table_info(steps)').all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    const byName = Object.fromEntries(columns.map((c) => [c.name, c]));
    expect(byName['id'].pk).toBe(1);
    expect(byName['run_id'].notnull).toBe(1);
    expect(byName['phase_id'].notnull).toBe(1);
    expect(byName['idx'].notnull).toBe(1);
    expect(byName['title'].notnull).toBe(1);
    expect(byName['status'].notnull).toBe(1);
    expect(byName['started_at'].notnull).toBe(0);
    expect(byName['completed_at'].notnull).toBe(0);
    db.close();
  });

  it('enforces UNIQUE(run_id, phase_id, idx)', () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO steps (id, run_id, phase_id, idx, title)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('step-1', 'run-1', 'implement', 1, 'Step one');
    expect(() =>
      db
        .prepare(
          `INSERT INTO steps (id, run_id, phase_id, idx, title)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('step-2', 'run-1', 'implement', 1, 'Step one again'),
    ).toThrow();
    db.close();
  });

  it('creates idx_steps_run_id index', () => {
    const db = freshDb();
    const indexes = db.prepare('PRAGMA index_list(steps)').all() as Array<{
      name: string;
    }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_steps_run_id');
    db.close();
  });

  it('schema_version records migration 14', () => {
    const db = freshDb();
    const row = db.prepare('SELECT version FROM schema_version WHERE version = 14').get() as
      | { version: number }
      | undefined;
    expect(row?.version).toBe(14);
    db.close();
  });
});
