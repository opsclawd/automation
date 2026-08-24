import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, openDatabase, applyMigrations } from '../../index.js';

function buildDbAtVersion34() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-m35-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  db.function('sha256', (value: string) => createHash('sha256').update(value).digest());
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);
  for (const migration of MIGRATIONS.filter(({ version }) => version <= 34)) {
    db.exec(migration.sql);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      migration.version,
      new Date().toISOString(),
    );
  }
  return db;
}

describe('migration 0035 — add job resume disposition', () => {
  it('adds nullable resume_disposition to a populated jobs table', () => {
    const db = buildDbAtVersion34();
    db.prepare(
      `INSERT INTO jobs (id, run_id, repo_id, issue_number, status, priority, attempts, created_at)
       VALUES ('job-existing-1', 'run-1', 'repo-1', 42, 'queued', 0, 0, '2026-01-01T00:00:00.000Z')`,
    ).run();

    applyMigrations(db);

    const columns = db.prepare(`PRAGMA table_info('jobs')`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    expect(columns).toContainEqual(
      expect.objectContaining({
        name: 'resume_disposition',
        type: 'TEXT',
        notnull: 0,
      }),
    );

    const row = db
      .prepare(
        `SELECT id, run_id, repo_id, issue_number, status, resume_disposition FROM jobs WHERE id = 'job-existing-1'`,
      )
      .get() as {
      id: string;
      run_id: string;
      repo_id: string;
      issue_number: number;
      status: string;
      resume_disposition: string | null;
    };
    expect(row.id).toBe('job-existing-1');
    expect(row.run_id).toBe('run-1');
    expect(row.repo_id).toBe('repo-1');
    expect(row.issue_number).toBe(42);
    expect(row.status).toBe('queued');
    expect(row.resume_disposition).toBeNull();

    // Verify new jobs can be inserted with non-null values
    db.prepare(
      `INSERT INTO jobs (id, run_id, repo_id, issue_number, status, priority, attempts, created_at, resume_disposition)
       VALUES ('job-new-1', 'run-1', 'repo-1', 43, 'queued', 0, 0, '2026-01-01T00:00:00.000Z', 'preserve_working_tree'),
              ('job-new-2', 'run-1', 'repo-1', 44, 'queued', 0, 0, '2026-01-01T00:00:00.000Z', 'reset_to_baseline')`,
    ).run();

    const newRow1 = db
      .prepare(`SELECT resume_disposition FROM jobs WHERE id = 'job-new-1'`)
      .get() as {
      resume_disposition: string | null;
    };
    expect(newRow1.resume_disposition).toBe('preserve_working_tree');

    const newRow2 = db
      .prepare(`SELECT resume_disposition FROM jobs WHERE id = 'job-new-2'`)
      .get() as {
      resume_disposition: string | null;
    };
    expect(newRow2.resume_disposition).toBe('reset_to_baseline');

    db.close();
  });
});
