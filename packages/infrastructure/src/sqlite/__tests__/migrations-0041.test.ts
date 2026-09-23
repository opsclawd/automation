import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, MIGRATIONS } from '../../index.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-m41-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  return { db, dir };
}

describe('migration 0041 — reconcile historical non-terminal jobs for terminal runs', () => {
  it('reconciles historical orphaned running/claimed/queued jobs for terminal runs and leaves active jobs untouched', () => {
    const { db } = freshDb();

    // 1. Apply migrations up to 40
    db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );`);

    const m40OrLess = MIGRATIONS.filter((m) => m.version <= 40);
    for (const m of m40OrLess) {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        m.version,
        new Date().toISOString(),
      );
    }

    // 2. Insert test data under schema 40:
    // Create 3 runs for each terminal state (total 9 historical runs) + 1 active running run
    // Passed runs
    for (let i = 1; i <= 3; i++) {
      db.prepare(
        `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, started_at, completed_at)
         VALUES (?, ?, 'owner/repo', ?, 'issue_to_pr', 'passed', '2026-09-18T10:00:00.000Z', '2026-09-18T11:00:00.000Z')`,
      ).run(`run-passed-${i}`, `run-passed-${i}`, 100 + i);

      db.prepare(
        `INSERT INTO jobs (id, run_id, repo_id, issue_number, status, priority, attempts, claimed_by, claim_token, created_at, claimed_at, started_at, claim_expires_at)
         VALUES (?, ?, 'owner/repo', ?, 'running', 0, 1, 'worker-1', 'tok-1', '2026-09-18T10:00:00.000Z', '2026-09-18T10:00:01.000Z', '2026-09-18T10:00:02.000Z', '2026-09-18T10:10:00.000Z')`,
      ).run(`job-passed-${i}`, `run-passed-${i}`, 100 + i);
    }

    // Failed runs
    for (let i = 1; i <= 3; i++) {
      db.prepare(
        `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, started_at, completed_at)
         VALUES (?, ?, 'owner/repo', ?, 'issue_to_pr', 'failed', '2026-09-19T10:00:00.000Z', '2026-09-19T11:00:00.000Z')`,
      ).run(`run-failed-${i}`, `run-failed-${i}`, 200 + i);

      db.prepare(
        `INSERT INTO jobs (id, run_id, repo_id, issue_number, status, priority, attempts, claimed_by, claim_token, created_at, claimed_at, started_at, claim_expires_at)
         VALUES (?, ?, 'owner/repo', ?, 'running', 0, 1, 'worker-2', 'tok-2', '2026-09-19T10:00:00.000Z', '2026-09-19T10:00:01.000Z', '2026-09-19T10:00:02.000Z', '2026-09-19T10:10:00.000Z')`,
      ).run(`job-failed-${i}`, `run-failed-${i}`, 200 + i);
    }

    // Cancelled runs
    for (let i = 1; i <= 3; i++) {
      db.prepare(
        `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, started_at, completed_at)
         VALUES (?, ?, 'owner/repo', ?, 'issue_to_pr', 'cancelled', '2026-09-20T10:00:00.000Z', '2026-09-20T11:00:00.000Z')`,
      ).run(`run-cancelled-${i}`, `run-cancelled-${i}`, 300 + i);

      db.prepare(
        `INSERT INTO jobs (id, run_id, repo_id, issue_number, status, priority, attempts, claimed_by, claim_token, created_at, claimed_at, started_at, claim_expires_at)
         VALUES (?, ?, 'owner/repo', ?, 'running', 0, 1, 'worker-3', 'tok-3', '2026-09-20T10:00:00.000Z', '2026-09-20T10:00:01.000Z', '2026-09-20T10:00:02.000Z', '2026-09-20T10:10:00.000Z')`,
      ).run(`job-cancelled-${i}`, `run-cancelled-${i}`, 300 + i);
    }

    // 1 Active run and job (should NOT be modified)
    db.prepare(
      `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, started_at)
       VALUES ('run-active', 'run-active', 'owner/repo', 999, 'issue_to_pr', 'running', '2026-09-22T20:00:00.000Z')`,
    ).run();

    db.prepare(
      `INSERT INTO jobs (id, run_id, repo_id, issue_number, status, priority, attempts, claimed_by, claim_token, created_at, claimed_at, started_at, claim_expires_at)
       VALUES ('job-active', 'run-active', 'owner/repo', 999, 'running', 0, 1, 'worker-live', 'live-token', '2026-09-22T20:00:00.000Z', '2026-09-22T20:00:01.000Z', '2026-09-22T20:00:02.000Z', '2026-09-22T20:10:00.000Z')`,
    ).run();

    // 3. Apply migration 41
    const m41 = MIGRATIONS.find((m) => m.version === 41);
    expect(m41).toBeDefined();
    db.exec(m41!.sql);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      m41!.version,
      new Date().toISOString(),
    );

    // 4. Verify the 9 historical jobs are reconciled
    for (let i = 1; i <= 3; i++) {
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(`job-passed-${i}`) as Record<
        string,
        unknown
      >;
      expect(job.status).toBe('succeeded');
      expect(job.completed_at).toBe('2026-09-18T11:00:00.000Z');
      expect(job.claimed_by).toBeNull();
      expect(job.claim_token).toBeNull();
      expect(job.claim_expires_at).toBeNull();
    }

    for (let i = 1; i <= 3; i++) {
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(`job-failed-${i}`) as Record<
        string,
        unknown
      >;
      expect(job.status).toBe('failed');
      expect(job.completed_at).toBe('2026-09-19T11:00:00.000Z');
      expect(job.claimed_by).toBeNull();
      expect(job.claim_token).toBeNull();
      expect(job.claim_expires_at).toBeNull();
    }

    for (let i = 1; i <= 3; i++) {
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(`job-cancelled-${i}`) as Record<
        string,
        unknown
      >;
      expect(job.status).toBe('cancelled');
      expect(job.completed_at).toBe('2026-09-20T11:00:00.000Z');
      expect(job.claimed_by).toBeNull();
      expect(job.claim_token).toBeNull();
      expect(job.claim_expires_at).toBeNull();
    }

    // 5. Verify the active job was untouched
    const activeJob = db.prepare('SELECT * FROM jobs WHERE id = ?').get('job-active') as Record<
      string,
      unknown
    >;
    expect(activeJob.status).toBe('running');
    expect(activeJob.claimed_by).toBe('worker-live');
    expect(activeJob.claim_token).toBe('live-token');
    expect(activeJob.completed_at).toBeNull();

    db.close();
  });
});
