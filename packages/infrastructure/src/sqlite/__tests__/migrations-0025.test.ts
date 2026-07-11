import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, MIGRATIONS } from '../../index.js';

function buildDbAtVersion24() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-m25-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  db.function('sha256', (val: string) => createHash('sha256').update(val).digest());
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);
  for (const m of MIGRATIONS.filter((x) => x.version <= 24)) {
    db.exec(m.sql);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      m.version,
      new Date().toISOString(),
    );
  }
  return db;
}

describe('migration 0025 — review state', () => {
  it('creates review_attempts table with correct columns', () => {
    const db = buildDbAtVersion24();

    const m25 = MIGRATIONS.find((m) => m.version === 25);
    expect(m25).toBeDefined();
    db.exec(m25!.sql);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      m25!.version,
      new Date().toISOString(),
    );

    const rows = db
      .prepare(
        `SELECT id, run_uuid, scope, step, review_mode, created_at, artifacts_json FROM review_attempts`,
      )
      .all();
    expect(rows).toHaveLength(0);

    db.prepare(
      `INSERT INTO review_attempts (id, run_uuid, scope, step, review_mode, created_at, artifacts_json)
       VALUES ('attempt-1', 'run-1', 'review', 'plan-review', 'initial_full', '2026-07-01T00:00:00Z', '["artifact1.txt"]')`,
    ).run();

    const row = db.prepare(`SELECT * FROM review_attempts WHERE id = 'attempt-1'`).get() as {
      id: string;
      run_uuid: string;
      scope: string;
      step: string;
      review_mode: string;
      artifacts_json: string;
    };
    expect(row.run_uuid).toBe('run-1');
    expect(row.scope).toBe('review');
    expect(row.step).toBe('plan-review');
    expect(row.review_mode).toBe('initial_full');
    expect(JSON.parse(row.artifacts_json)).toEqual(['artifact1.txt']);
    db.close();
  });

  it('creates review_dimension_states table with correct columns', () => {
    const db = buildDbAtVersion24();

    const m25 = MIGRATIONS.find((m) => m.version === 25);
    db.exec(m25!.sql);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      m25!.version,
      new Date().toISOString(),
    );

    const rows = db.prepare(`SELECT * FROM review_dimension_states`).all();
    expect(rows).toHaveLength(0);

    db.prepare(
      `INSERT INTO review_dimension_states
         (id, run_uuid, scope, step, dimension, latest_snapshot_kind, latest_snapshot_identity,
          latest_verdict, dirty, provisionally_clean, unresolved_records_json, disposition_history_json, updated_at)
       VALUES ('run-1|review|plan-review|quality', 'run-1', 'review', 'plan-review', 'quality',
               'git', 'sha-abc123', 'pass', 1, 0, '[{"reviewerKind":"quality","severity":"high","summary":"test","fingerprint":"fp1"}]',
               '[{"disposition":"open","changedAt":"2026-07-01T00:00:00Z"}]', '2026-07-01T00:00:00Z')`,
    ).run();

    const row = db
      .prepare(
        `SELECT * FROM review_dimension_states WHERE id = 'run-1|review|plan-review|quality'`,
      )
      .get() as {
      dimension: string;
      latest_snapshot_kind: string;
      latest_verdict: string;
      dirty: number;
      provisionally_clean: number;
    };
    expect(row.dimension).toBe('quality');
    expect(row.latest_snapshot_kind).toBe('git');
    expect(row.dirty).toBe(1);
    expect(row.provisionally_clean).toBe(0);
    db.close();
  });

  it('creates indexes on review_attempts and review_dimension_states', () => {
    const db = buildDbAtVersion24();

    const m25 = MIGRATIONS.find((m) => m.version === 25);
    db.exec(m25!.sql);

    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_review_%'`)
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain('idx_review_attempts_run_scope');
    expect(indexes.map((i) => i.name)).toContain('idx_review_attempts_created_at');
    expect(indexes.map((i) => i.name)).toContain('idx_review_dimension_states_run_scope');
    db.close();
  });

  it('is additive and does not affect existing tables', () => {
    const db = buildDbAtVersion24();
    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, started_at)
       VALUES ('run-existing', 'run-existing', 1, 'issue', 'running', '2026-07-01T00:00:00Z')`,
    ).run();

    const m25 = MIGRATIONS.find((m) => m.version === 25);
    db.exec(m25!.sql);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      m25!.version,
      new Date().toISOString(),
    );

    const runRow = db.prepare(`SELECT uuid FROM runs WHERE uuid = 'run-existing'`).get();
    expect(runRow).toBeDefined();
    db.close();
  });
});
