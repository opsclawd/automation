import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, applyMigrations, MIGRATIONS } from '../../index.js';

describe('migration 0038: add release batches', () => {
  it('applies cleanly on a fresh database and creates tables with all expected columns', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);

    const batchCols = (
      db.prepare(`PRAGMA table_info('release_batches')`).all() as Array<{ name: string }>
    ).map((c) => c.name);

    for (const col of [
      'id',
      'repo_id',
      'source_branch',
      'source_start_sha',
      'release_branch',
      'status',
      'current_position',
      'candidate_sha',
      'approved_candidate_sha',
      'blocked_reason',
      'created_at',
      'completed_at',
    ]) {
      expect(batchCols).toContain(col);
    }

    const itemCols = (
      db.prepare(`PRAGMA table_info('release_batch_items')`).all() as Array<{ name: string }>
    ).map((c) => c.name);

    for (const col of [
      'release_batch_id',
      'position',
      'issue_number',
      'status',
      'run_uuid',
      'pr_number',
      'base_sha',
      'merged_commit_sha',
      'blocked_reason',
      'started_at',
      'completed_at',
    ]) {
      expect(itemCols).toContain(col);
    }

    db.close();
  });

  it('applies cleanly on an existing database migrated up to 0037', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-orch-mig-0038-'));
    const db = openDatabase(join(dir, 'db.sqlite'));

    // Apply all migrations up to version 37
    db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );`);

    const pre0038Migrations = MIGRATIONS.filter((m) => m.version <= 37);
    for (const m of pre0038Migrations) {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        m.version,
        new Date().toISOString(),
      );
    }

    const versionBefore = (
      db.prepare('SELECT MAX(version) as max_v FROM schema_version').get() as { max_v: number }
    ).max_v;
    expect(versionBefore).toBe(37);

    // Now apply migrations which includes 0038
    applyMigrations(db);

    const versionAfter = (
      db.prepare('SELECT MAX(version) as max_v FROM schema_version').get() as { max_v: number }
    ).max_v;
    expect(versionAfter).toBe(38);

    db.close();
  });

  it('cascades deletion from release_batches to release_batch_items', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);

    db.prepare(
      `INSERT INTO release_batches
        (id, repo_id, source_branch, source_start_sha, release_branch, status, current_position, created_at)
       VALUES ('rb-del-1', 'repo-1', 'main', 'sha1', 'release/1', 'queued', 1, datetime('now'))`,
    ).run();

    db.prepare(
      `INSERT INTO release_batch_items
        (release_batch_id, position, issue_number, status)
       VALUES
        ('rb-del-1', 1, 10, 'pending'),
        ('rb-del-1', 2, 20, 'pending')`,
    ).run();

    expect(
      (
        db
          .prepare('SELECT COUNT(*) as c FROM release_batch_items WHERE release_batch_id = ?')
          .get('rb-del-1') as { c: number }
      ).c,
    ).toBe(2);

    db.prepare('DELETE FROM release_batches WHERE id = ?').run('rb-del-1');

    expect(
      (
        db
          .prepare('SELECT COUNT(*) as c FROM release_batch_items WHERE release_batch_id = ?')
          .get('rb-del-1') as { c: number }
      ).c,
    ).toBe(0);

    db.close();
  });
});
