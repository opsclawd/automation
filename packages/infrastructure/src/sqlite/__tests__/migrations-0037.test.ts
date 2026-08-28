import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, MIGRATIONS } from '../../index.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-m37-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  return { db, dir };
}

describe('migration 0037 — add execution_policy column to runs table', () => {
  it('creates execution_policy column and backfills existing runs with legacy', () => {
    const { db } = freshDb();

    // 1. Apply migrations up to 36
    db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );`);

    const m36OrLess = MIGRATIONS.filter((m) => m.version <= 36);
    for (const m of m36OrLess) {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        m.version,
        new Date().toISOString(),
      );
    }

    // 2. Insert a run with schema 36 (which does not have execution_policy)
    db.prepare(
      `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, started_at)
       VALUES ('run-old-1', 'run-old-1', 'owner/repo', 42, 'issue', 'running', datetime('now'))`,
    ).run();

    // Verify column does not exist yet on runs
    const colsBefore = db.prepare(`PRAGMA table_info('runs')`).all() as Array<{ name: string }>;
    const namesBefore = colsBefore.map((c) => c.name);
    expect(namesBefore).not.toContain('execution_policy');

    // 3. Apply migration 37
    const m37 = MIGRATIONS.find((m) => m.version === 37);
    expect(m37).toBeDefined();
    db.exec(m37!.sql);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      m37!.version,
      new Date().toISOString(),
    );

    // 4. Verify column exists now
    const colsAfter = db.prepare(`PRAGMA table_info('runs')`).all() as Array<{ name: string }>;
    const namesAfter = colsAfter.map((c) => c.name);
    expect(namesAfter).toContain('execution_policy');

    // 5. Verify backfill
    const run = db.prepare(`SELECT execution_policy FROM runs WHERE uuid = 'run-old-1'`).get() as {
      execution_policy: string;
    };
    expect(run.execution_policy).toBe('legacy');

    db.close();
  });
});
