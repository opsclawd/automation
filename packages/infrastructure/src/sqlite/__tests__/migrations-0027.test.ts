import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, MIGRATIONS } from '../../index.js';

function buildDbAtVersion26() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-m27-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  db.function('sha256', (val: string) => createHash('sha256').update(val).digest());
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);
  for (const m of MIGRATIONS.filter((x) => x.version <= 26)) {
    db.exec(m.sql);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      m.version,
      new Date().toISOString(),
    );
  }
  return db;
}

describe('migration 0027 — repository-scoped queue', () => {
  it('creates idx_jobs_repo_status_priority_created_id index', () => {
    const db = buildDbAtVersion26();

    const m27 = MIGRATIONS.find((m) => m.version === 27);
    expect(m27).toBeDefined();
    db.exec(m27!.sql);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      m27!.version,
      new Date().toISOString(),
    );

    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_jobs_%'`)
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain('idx_jobs_repo_status_priority_created_id');
    db.close();
  });

  it('index supports repository-scoped queue queries', () => {
    const db = buildDbAtVersion26();

    const m27 = MIGRATIONS.find((m) => m.version === 27);
    db.exec(m27!.sql);

    db.prepare(
      `INSERT INTO jobs (id, run_id, repo_id, issue_number, status, priority, attempts, claimed_by, created_at, claimed_at, started_at, completed_at, claim_expires_at)
       VALUES ('job-a', 'run-1', 'repo-1', 1, 'queued', 5, 0, NULL, '2026-01-01T00:00:00Z', NULL, NULL, NULL, NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO jobs (id, run_id, repo_id, issue_number, status, priority, attempts, claimed_by, created_at, claimed_at, started_at, completed_at, claim_expires_at)
       VALUES ('job-b', 'run-2', 'repo-2', 2, 'queued', 10, 0, NULL, '2026-01-01T00:00:00Z', NULL, NULL, NULL, NULL)`,
    ).run();

    const rows = db
      .prepare(
        `SELECT * FROM jobs WHERE status = 'queued' AND repo_id = 'repo-1' ORDER BY priority DESC, created_at ASC, id ASC`,
      )
      .all();
    expect(rows).toHaveLength(1);
    expect((rows[0] as { id: string }).id).toBe('job-a');
    db.close();
  });

  it('is additive and does not affect existing tables', () => {
    const db = buildDbAtVersion26();
    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, started_at)
       VALUES ('run-existing', 'run-existing', 1, 'issue', 'running', '2026-07-01T00:00:00Z')`,
    ).run();

    const m27 = MIGRATIONS.find((m) => m.version === 27);
    db.exec(m27!.sql);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      m27!.version,
      new Date().toISOString(),
    );

    const runRow = db.prepare(`SELECT uuid FROM runs WHERE uuid = 'run-existing'`).get();
    expect(runRow).toBeDefined();
    db.close();
  });
});
