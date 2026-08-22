import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, openDatabase, applyMigrations } from '../../index.js';

function buildDbAtVersion33() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-m34-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  db.function('sha256', (value: string) => createHash('sha256').update(value).digest());
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);
  for (const migration of MIGRATIONS.filter(({ version }) => version <= 33)) {
    db.exec(migration.sql);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      migration.version,
      new Date().toISOString(),
    );
  }
  return db;
}

describe('migration 0034 — add step revert counts', () => {
  it('0034 upgrades an existing steps table with a non-null empty revert map', () => {
    const db = buildDbAtVersion33();
    db.prepare(
      `INSERT INTO steps (id, run_id, phase_id, idx, title, status)
       VALUES ('step-1', 'run-1', 'implement', 1, 'Task 1', 'failed')`,
    ).run();

    applyMigrations(db);

    const columns = db.prepare(`PRAGMA table_info('steps')`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    expect(columns).toContainEqual(
      expect.objectContaining({
        name: 'revert_counts',
        type: 'TEXT',
        notnull: 1,
        dflt_value: "'{}'",
      }),
    );
    const row = db.prepare(`SELECT revert_counts FROM steps WHERE id = 'step-1'`).get() as {
      revert_counts: string;
    };
    expect(row.revert_counts).toBe('{}');
    db.close();
  });
});
