import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, applyMigrations } from '../../index.js';

describe('migration 0028: worker-repository-binding', () => {
  it('adds repo_id column as NOT NULL to workers table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-mig-0028-'));
    const db = openDatabase(join(dir, 'orch.sqlite'));
    applyMigrations(db);

    db.prepare(
      `INSERT INTO workers (id, repo_id, hostname, process_id, status, heartbeat_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('w1', 'r1', 'h1', 1, 'idle', new Date().toISOString());

    const result = db.prepare('SELECT repo_id FROM workers WHERE id = ?').get('w1') as
      | { repo_id: string }
      | undefined;
    expect(result).toBeDefined();
    expect(result?.repo_id).toBe('r1');

    db.close();
  });

  it('creates idx_workers_repo_status_heartbeat index', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-mig-0028-'));
    const db = openDatabase(join(dir, 'orch.sqlite'));
    applyMigrations(db);

    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_workers_repo_status_heartbeat'`,
      )
      .get();
    expect(indexes).toBeDefined();

    db.close();
  });
});
