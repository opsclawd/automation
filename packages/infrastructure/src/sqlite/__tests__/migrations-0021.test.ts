import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, MIGRATIONS } from '../../index.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-m21-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  return { db, dir };
}

describe('migration 0021 — config provenance in runs table', () => {
  it('creates columns and backfills existing runs', () => {
    const { db } = freshDb();

    // 1. Apply migrations up to 20
    db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );`);

    const m20OrLess = MIGRATIONS.filter((m) => m.version <= 20);
    for (const m of m20OrLess) {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        m.version,
        new Date().toISOString(),
      );
    }

    // 2. Insert a run with schema 20 (which does not have config_fingerprint or config_sources_json)
    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, started_at)
       VALUES ('run-old-1', 'run-old-1', 42, 'issue', 'running', datetime('now'))`,
    ).run();

    // Verify columns do not exist yet on runs
    const colsBefore = db.prepare(`PRAGMA table_info('runs')`).all() as Array<{ name: string }>;
    const namesBefore = colsBefore.map((c) => c.name);
    expect(namesBefore).not.toContain('config_fingerprint');
    expect(namesBefore).not.toContain('config_sources_json');

    // 3. Apply migration 21
    const m21 = MIGRATIONS.find((m) => m.version === 21);
    expect(m21).toBeDefined();
    db.exec(m21!.sql);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      m21!.version,
      new Date().toISOString(),
    );

    // 4. Verify columns exist now
    const colsAfter = db.prepare(`PRAGMA table_info('runs')`).all() as Array<{ name: string }>;
    const namesAfter = colsAfter.map((c) => c.name);
    expect(namesAfter).toContain('config_fingerprint');
    expect(namesAfter).toContain('config_sources_json');

    // 5. Verify backfill
    const run = db
      .prepare(`SELECT config_fingerprint, config_sources_json FROM runs WHERE uuid = 'run-old-1'`)
      .get() as {
      config_fingerprint: string;
      config_sources_json: string;
    };
    expect(run.config_fingerprint).toBe(
      '19d021bbabac38fc537e2fee672bb5ce6a06c5a7cfcc661c762955f8893c4e25',
    );
    expect(run.config_sources_json).toBe('[]');

    db.close();
  });
});
