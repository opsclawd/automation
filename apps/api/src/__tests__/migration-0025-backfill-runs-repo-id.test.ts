import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { up as apply0025 } from '../../../../packages/infrastructure/src/migrations/0025-backfill-runs-repo-id-from-registry';

interface RepositoryRow {
  id: string;
  full_name: string;
}

interface RunRow {
  uuid: string;
  repo_id: string;
}

interface IndexRow {
  name: string;
}

describe('migration-0025-backfill-runs-repo-id', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    // Setup repositories table
    db.exec(`
      CREATE TABLE repositories (
        id TEXT PRIMARY KEY,
        full_name TEXT NOT NULL UNIQUE,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        local_base_path TEXT NOT NULL UNIQUE,
        default_branch TEXT NOT NULL,
        remote_url TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        max_concurrent_runs INTEGER NOT NULL DEFAULT 1,
        config_metadata TEXT NOT NULL DEFAULT '{}',
        health_status TEXT NOT NULL DEFAULT 'unknown',
        health_error TEXT,
        last_health_check_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    // Setup runs table with a repo_id column and issue_number
    db.exec(`
      CREATE TABLE runs (
        uuid TEXT PRIMARY KEY,
        display_id TEXT NOT NULL,
        issue_number INTEGER,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        repo_id TEXT,
        config_sources_json TEXT,
        started_at TEXT NOT NULL
      );
    `);
  });

  it('should fallback to synthetic repository if no repositories exist', async () => {
    // 1. Insert a run with null or empty repo_id
    db.prepare(
      `
      INSERT INTO runs (uuid, display_id, issue_number, type, status, repo_id, started_at)
      VALUES ('run-1', 'run-1', 42, 'issue', 'running', NULL, '2026-01-01T00:00:00.000Z')
    `,
    ).run();

    // 2. Apply migration 0025
    await apply0025(db);

    // 3. Verify repository unknown/unknown was created
    const repos = db.prepare('SELECT * FROM repositories').all() as RepositoryRow[];
    expect(repos).toHaveLength(1);
    expect(repos[0].full_name).toBe('unknown/unknown');

    // 4. Verify run was updated with the synthetic repository's ID
    const run = db.prepare('SELECT repo_id FROM runs WHERE uuid = ?').get('run-1') as RunRow;
    expect(run.repo_id).toBe(repos[0].id);
  });

  it('should use the first repository when repositories already exist', async () => {
    // 1. Insert a repository
    db.prepare(
      `
      INSERT INTO repositories (id, full_name, owner, name, local_base_path, default_branch, remote_url, enabled, health_status, created_at, updated_at)
      VALUES ('repo-existing-id', 'acme/widgets', 'acme', 'widgets', '/repos/widgets', 'main', '', 1, 'unknown', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `,
    ).run();

    // 2. Insert runs with empty, null, or 'unknown' repo_ids
    db.prepare(
      `
      INSERT INTO runs (uuid, display_id, issue_number, type, status, repo_id, started_at)
      VALUES ('run-null', 'run-null', 1, 'issue', 'running', NULL, '2026-01-01T00:00:00.000Z')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO runs (uuid, display_id, issue_number, type, status, repo_id, started_at)
      VALUES ('run-empty', 'run-empty', 2, 'issue', 'running', '', '2026-01-01T00:00:00.000Z')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO runs (uuid, display_id, issue_number, type, status, repo_id, started_at)
      VALUES ('run-unknown', 'run-unknown', 3, 'issue', 'running', 'unknown', '2026-01-01T00:00:00.000Z')
    `,
    ).run();

    // 3. Apply migration 0025
    await apply0025(db);

    // 4. Verify no new repository was created
    const repos = db.prepare('SELECT * FROM repositories').all() as RepositoryRow[];
    expect(repos).toHaveLength(1);
    expect(repos[0].id).toBe('repo-existing-id');

    // 5. Verify all runs were updated to 'repo-existing-id'
    const runs = db.prepare('SELECT uuid, repo_id FROM runs').all() as RunRow[];
    expect(runs).toHaveLength(3);
    for (const r of runs) {
      expect(r.repo_id).toBe('repo-existing-id');
    }
  });

  it('should create index on runs(repo_id, issue_number)', async () => {
    await apply0025(db);

    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'runs'`)
      .all() as IndexRow[];
    const hasIndex = indexes.some((idx) => idx.name === 'idx_runs_repo_id_issue_number');
    expect(hasIndex).toBe(true);
  });
});
