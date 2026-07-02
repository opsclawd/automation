import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, applyMigrations } from '../../index.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-m17-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  applyMigrations(db);
  return db;
}

describe('migration 0017 — workers table', () => {
  it('creates the workers table with expected columns', () => {
    const db = freshDb();
    const columns = db.prepare('PRAGMA table_info(workers)').all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    const byName = Object.fromEntries(columns.map((c) => [c.name, c]));
    expect(byName['id'].pk).toBe(1);
    expect(byName['id'].type).toBe('TEXT');
    expect(byName['hostname'].notnull).toBe(1);
    expect(byName['process_id'].notnull).toBe(1);
    expect(byName['process_id'].type).toBe('INTEGER');
    expect(byName['status'].notnull).toBe(1);
    expect(byName['heartbeat_at'].notnull).toBe(1);
    db.close();
  });

  it('schema_version records migration 17', () => {
    const db = freshDb();
    const row = db.prepare('SELECT version FROM schema_version WHERE version = 17').get() as
      | { version: number }
      | undefined;
    expect(row?.version).toBe(17);
    db.close();
  });
});
