import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, openDatabase } from '../../index.js';

function buildDbAtVersion31() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-m32-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  db.function('sha256', (value: string) => createHash('sha256').update(value).digest());
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);
  for (const migration of MIGRATIONS.filter(({ version }) => version <= 31)) {
    db.exec(migration.sql);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      migration.version,
      new Date().toISOString(),
    );
  }
  return db;
}

describe('migration 0032 — add initial pre-step HEAD', () => {
  it('migration adds nullable initial_pre_step_head without backfilling existing steps', () => {
    const db = buildDbAtVersion31();
    db.prepare(
      `INSERT INTO steps (id, run_id, phase_id, idx, title, status)
       VALUES ('step-1', 'run-1', 'implement', 1, 'Task 1', 'failed')`,
    ).run();

    const migration = MIGRATIONS.find(({ version }) => version === 32);
    expect(migration).toBeDefined();
    db.exec(migration!.sql);

    const columns = db.prepare(`PRAGMA table_info('steps')`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;
    expect(columns).toContainEqual(
      expect.objectContaining({
        name: 'initial_pre_step_head',
        type: 'TEXT',
        notnull: 0,
      }),
    );
    const row = db.prepare(`SELECT initial_pre_step_head FROM steps WHERE id = 'step-1'`).get() as {
      initial_pre_step_head: string | null;
    };
    expect(row.initial_pre_step_head).toBeNull();
    db.close();
  });
});
