import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, MIGRATIONS } from '../../index.js';

function buildDbAtVersion22() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-m23-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  db.function('sha256', (val: string) => createHash('sha256').update(val).digest());
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);
  for (const m of MIGRATIONS.filter((x) => x.version <= 22)) {
    db.exec(m.sql);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      m.version,
      new Date().toISOString(),
    );
  }
  return db;
}

describe('migration 0023 — repository registry backfill', () => {
  it('creates a synthetic repository from runs.config_sources_json', () => {
    const db = buildDbAtVersion22();
    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, started_at,
        config_sources_json)
       VALUES ('run-1', 'run-1', 42, 'issue', 'running', '2026-01-01T00:00:00.000Z',
         '[{"fullName":"acme/widgets","owner":"acme","name":"widgets","localBasePath":"/r/w","defaultBranch":"main","remoteUrl":"git@github.com:acme/widgets.git"}]')`,
    ).run();

    const m23 = MIGRATIONS.find((m) => m.version === 23);
    expect(m23).toBeDefined();
    db.exec(m23!.sql);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      m23!.version,
      new Date().toISOString(),
    );

    const rows = db.prepare('SELECT id, full_name, owner, name FROM repositories').all() as Array<{
      id: string;
      full_name: string;
      owner: string;
      name: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].full_name).toBe('acme/widgets');
    expect(rows[0].owner).toBe('acme');
    expect(rows[0].name).toBe('widgets');
    expect(rows[0].id).toMatch(/^[a-f0-9]{64}$/);
    db.close();
  });

  it('re-points legacy repo_id = unknown runs to the synthetic id', () => {
    const db = buildDbAtVersion22();
    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, started_at, repo_id,
        config_sources_json)
       VALUES ('run-old', 'run-old', 1, 'issue', 'passed', '2026-01-01T00:00:00.000Z', 'unknown',
         '[{"fullName":"acme/widgets","owner":"acme","name":"widgets","localBasePath":"/r/w","defaultBranch":"main","remoteUrl":"git@github.com:acme/widgets.git"}]')`,
    ).run();

    const m23 = MIGRATIONS.find((m) => m.version === 23);
    db.exec(m23!.sql);

    const row = db.prepare(`SELECT repo_id FROM runs WHERE uuid = 'run-old'`).get() as {
      repo_id: string;
    };
    expect(row.repo_id).not.toBe('unknown');
    const reg = db
      .prepare(`SELECT id FROM repositories WHERE full_name = 'acme/widgets'`)
      .get() as { id: string };
    expect(row.repo_id).toBe(reg.id);
    db.close();
  });

  it('is a no-op when no config_sources_json rows exist', () => {
    const db = buildDbAtVersion22();
    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, started_at)
       VALUES ('r', 'r', 1, 'issue', 'running', '2026-01-01T00:00:00.000Z')`,
    ).run();
    const m23 = MIGRATIONS.find((m) => m.version === 23);
    db.exec(m23!.sql);
    const rows = db.prepare('SELECT id FROM repositories').all();
    expect(rows).toEqual([]);
    db.close();
  });
});
