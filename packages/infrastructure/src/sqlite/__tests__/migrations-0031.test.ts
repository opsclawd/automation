import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, MIGRATIONS } from '../../index.js';

function buildDbAtVersion30() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-m31-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  db.function('sha256', (val: string) => createHash('sha256').update(val).digest());
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);
  for (const m of MIGRATIONS.filter((x) => x.version <= 30)) {
    db.exec(m.sql);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      m.version,
      new Date().toISOString(),
    );
  }
  return db;
}

describe('migration 0031 — fence job claims', () => {
  it('migration backfills active job ownership generations', () => {
    const db = buildDbAtVersion30();

    const now = new Date('2026-01-01T00:00:00Z').toISOString();
    // Insert jobs at version 30 (which doesn't have claim_token column)
    db.prepare(
      `INSERT INTO jobs (id, run_id, repo_id, issue_number, status, priority, attempts, claimed_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('job-queued', 'run-1', 'repo-a', 42, 'queued', 0, 0, null, now);

    db.prepare(
      `INSERT INTO jobs (id, run_id, repo_id, issue_number, status, priority, attempts, claimed_by, created_at, claimed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('job-claimed', 'run-1', 'repo-a', 42, 'claimed', 0, 1, 'w1', now, now);

    db.prepare(
      `INSERT INTO jobs (id, run_id, repo_id, issue_number, status, priority, attempts, claimed_by, created_at, claimed_at, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('job-running', 'run-1', 'repo-a', 42, 'running', 0, 1, 'w1', now, now, now);

    db.prepare(
      `INSERT INTO jobs (id, run_id, repo_id, issue_number, status, priority, attempts, claimed_by, created_at, claimed_at, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('job-succeeded', 'run-1', 'repo-a', 42, 'succeeded', 0, 1, 'w1', now, now, now, now);

    // Apply migration 31
    const m31 = MIGRATIONS.find((m) => m.version === 31);
    expect(m31).toBeDefined();
    db.exec(m31!.sql);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      m31!.version,
      new Date().toISOString(),
    );

    // Assert claim_token for queued is null
    const rowQueued = db
      .prepare(`SELECT claim_token FROM jobs WHERE id = 'job-queued'`)
      .get() as unknown as { claim_token: string | null };
    expect(rowQueued.claim_token).toBeNull();

    // Assert claim_token for succeeded is null
    const rowSucceeded = db
      .prepare(`SELECT claim_token FROM jobs WHERE id = 'job-succeeded'`)
      .get() as unknown as { claim_token: string | null };
    expect(rowSucceeded.claim_token).toBeNull();

    // Assert claim_token for claimed is backfilled
    const rowClaimed = db
      .prepare(`SELECT claim_token FROM jobs WHERE id = 'job-claimed'`)
      .get() as unknown as { claim_token: string | null };
    expect(rowClaimed.claim_token).toBeTypeOf('string');
    expect(rowClaimed.claim_token!.length).toBeGreaterThan(0);

    // Assert claim_token for running is backfilled
    const rowRunning = db
      .prepare(`SELECT claim_token FROM jobs WHERE id = 'job-running'`)
      .get() as unknown as { claim_token: string | null };
    expect(rowRunning.claim_token).toBeTypeOf('string');
    expect(rowRunning.claim_token!.length).toBeGreaterThan(0);

    // Check idx_jobs_fence
    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = 'jobs'`)
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain('idx_jobs_fence');

    db.close();
  });
});
