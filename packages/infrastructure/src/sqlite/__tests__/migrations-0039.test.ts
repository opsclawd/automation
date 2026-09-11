import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, applyMigrations, MIGRATIONS } from '../../index.js';

describe('migration 0039: add release batch promotion fields', () => {
  it('applies cleanly on a fresh database and includes promotion columns', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);

    const batchCols = (
      db.prepare(`PRAGMA table_info('release_batches')`).all() as Array<{ name: string }>
    ).map((c) => c.name);

    expect(batchCols).toContain('candidate_tree_sha');
    expect(batchCols).toContain('promotion_commit_sha');
    expect(batchCols).toContain('promotion_pr_number');

    db.close();
  });

  it('applies cleanly on an existing database migrated up to 0038', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-orch-mig-0039-'));
    const db = openDatabase(join(dir, 'db.sqlite'));

    // Apply all migrations up to version 38
    db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );`);

    const pre0039Migrations = MIGRATIONS.filter((m) => m.version <= 38);
    for (const m of pre0039Migrations) {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        m.version,
        new Date().toISOString(),
      );
    }

    const versionBefore = (
      db.prepare('SELECT MAX(version) as max_v FROM schema_version').get() as { max_v: number }
    ).max_v;
    expect(versionBefore).toBe(38);

    // Verify columns do not exist yet
    const colsBefore = (
      db.prepare(`PRAGMA table_info('release_batches')`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(colsBefore).not.toContain('candidate_tree_sha');
    expect(colsBefore).not.toContain('promotion_commit_sha');
    expect(colsBefore).not.toContain('promotion_pr_number');

    // Now apply migrations which includes 0039
    applyMigrations(db);

    const versionAfter = (
      db.prepare('SELECT MAX(version) as max_v FROM schema_version').get() as { max_v: number }
    ).max_v;
    expect(versionAfter).toBeGreaterThanOrEqual(39);

    const colsAfter = (
      db.prepare(`PRAGMA table_info('release_batches')`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(colsAfter).toContain('candidate_tree_sha');
    expect(colsAfter).toContain('promotion_commit_sha');
    expect(colsAfter).toContain('promotion_pr_number');

    db.close();
  });
});
