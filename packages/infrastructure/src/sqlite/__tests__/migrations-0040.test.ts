import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, MIGRATIONS } from '../../index.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-m40-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  return { db, dir };
}

describe('migration 0040 — add pinned_runtime column to runs table', () => {
  it('adds pinned_runtime column to runs table leaving existing rows with null', () => {
    const { db } = freshDb();

    // 1. Apply migrations up to 39
    db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );`);

    const m39OrLess = MIGRATIONS.filter((m) => m.version <= 39);
    for (const m of m39OrLess) {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        m.version,
        new Date().toISOString(),
      );
    }

    // 2. Insert a run with schema 39 (which does not have pinned_runtime)
    db.prepare(
      `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, started_at)
       VALUES ('run-old-1', 'run-old-1', 'owner/repo', 42, 'issue', 'running', datetime('now'))`,
    ).run();

    // Verify column does not exist yet on runs
    const colsBefore = db.prepare(`PRAGMA table_info('runs')`).all() as Array<{ name: string }>;
    const namesBefore = colsBefore.map((c) => c.name);
    expect(namesBefore).not.toContain('pinned_runtime');

    // 3. Apply migration 40
    const m40 = MIGRATIONS.find((m) => m.version === 40);
    expect(m40).toBeDefined();
    db.exec(m40!.sql);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      m40!.version,
      new Date().toISOString(),
    );

    // 4. Verify column exists now
    const colsAfter = db.prepare(`PRAGMA table_info('runs')`).all() as Array<{ name: string }>;
    const namesAfter = colsAfter.map((c) => c.name);
    expect(namesAfter).toContain('pinned_runtime');

    // 5. Existing run has null pinned_runtime
    const run = db.prepare(`SELECT pinned_runtime FROM runs WHERE uuid = 'run-old-1'`).get() as {
      pinned_runtime: string | null;
    };
    expect(run.pinned_runtime).toBeNull();

    // 6. Insert new run with pinned_runtime under schema 40
    db.prepare(
      `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, started_at, pinned_runtime)
       VALUES ('run-new-1', 'run-new-1', 'owner/repo', 43, 'issue', 'running', datetime('now'), 'claude-code')`,
    ).run();

    const newRun = db.prepare(`SELECT pinned_runtime FROM runs WHERE uuid = 'run-new-1'`).get() as {
      pinned_runtime: string | null;
    };
    expect(newRun.pinned_runtime).toBe('claude-code');

    db.close();
  });
});
