import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, applyMigrations } from '../../index.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-m22-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  applyMigrations(db);
  return db;
}

describe('migration 0022 — repositories table', () => {
  it('creates repositories table with all required columns', () => {
    const db = freshDb();
    const cols = db.prepare('PRAGMA table_info(repositories)').all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    for (const required of [
      'id',
      'full_name',
      'owner',
      'name',
      'local_base_path',
      'default_branch',
      'remote_url',
      'enabled',
      'max_concurrent_runs',
      'config_metadata',
      'health_status',
      'health_error',
      'last_health_check_at',
      'created_at',
      'updated_at',
    ]) {
      expect(names).toContain(required);
    }
    db.close();
  });

  it('enforces UNIQUE on full_name and local_base_path', () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO repositories (id, full_name, owner, name, local_base_path, default_branch,
        remote_url, enabled, max_concurrent_runs, created_at, updated_at)
       VALUES ('r1', 'a/b', 'a', 'b', '/p1', 'main', 'url', 1, 1, 'now', 'now')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO repositories (id, full_name, owner, name, local_base_path, default_branch,
          remote_url, enabled, max_concurrent_runs, created_at, updated_at)
         VALUES ('r2', 'a/b', 'a', 'b', '/p2', 'main', 'url', 1, 1, 'now', 'now')`,
        )
        .run(),
    ).toThrow(/UNIQUE/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO repositories (id, full_name, owner, name, local_base_path, default_branch,
          remote_url, enabled, max_concurrent_runs, created_at, updated_at)
         VALUES ('r3', 'c/d', 'c', 'd', '/p1', 'main', 'url', 1, 1, 'now', 'now')`,
        )
        .run(),
    ).toThrow(/UNIQUE/);
    db.close();
  });

  it('creates idx_repositories_enabled index', () => {
    const db = freshDb();
    const indexes = db.prepare('PRAGMA index_list(repositories)').all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain('idx_repositories_enabled');
    db.close();
  });

  it('schema_version records migration 22', () => {
    const db = freshDb();
    const row = db.prepare('SELECT version FROM schema_version WHERE version = 22').get() as
      | { version: number }
      | undefined;
    expect(row?.version).toBe(22);
    db.close();
  });

  it('updated_at trigger fires on UPDATE', () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO repositories (id, full_name, owner, name, local_base_path, default_branch,
        remote_url, enabled, max_concurrent_runs, created_at, updated_at)
       VALUES ('r1', 'a/b', 'a', 'b', '/p1', 'main', 'url', 1, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();
    db.prepare(`UPDATE repositories SET enabled = 0 WHERE id = 'r1'`).run();
    const row = db.prepare(`SELECT updated_at FROM repositories WHERE id = 'r1'`).get() as {
      updated_at: string;
    };
    expect(row.updated_at).not.toBe('2026-01-01T00:00:00.000Z');
    db.close();
  });
});
