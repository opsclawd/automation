import { describe, it, expect } from 'vitest';
import { openDatabase, applyMigrations } from '../../index.js';

describe('migration 0008 — loops', () => {
  it('creates loops and loop_iterations tables', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: { name: string }) => r.name);

    expect(tables).toContain('loops');
    expect(tables).toContain('loop_iterations');
    db.close();
  });

  it('creates the run_uuid + phase_id index', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all()
      .map((r: { name: string }) => r.name);

    expect(indexes).toContain('idx_loops_run');
    db.close();
  });

  it('is idempotent on re-run', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    expect(() => applyMigrations(db)).not.toThrow();
    db.close();
  });

  it('cascades delete run → loops → loop_iterations', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);

    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, started_at, completed_phases)
       VALUES ('run-1', 'run-1', 1, 'issue_to_pr', 'running', '2026-06-14T00:00:00.000Z', '[]')`,
    ).run();
    db.prepare(
      `INSERT INTO loops (id, run_uuid, phase_id, type, max_iterations, status, started_at)
       VALUES ('loop-1', 'run-1', 'whole-pr-review', 'review-fix', 3, 'running', '2026-06-14T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO loop_iterations (loop_id, idx, review_invocation_id, outcome, started_at)
       VALUES ('loop-1', 1, 'r1', 'unresolved', '2026-06-14T00:00:00.000Z')`,
    ).run();

    db.prepare(`DELETE FROM runs WHERE uuid = 'run-1'`).run();

    expect(db.prepare(`SELECT COUNT(*) AS c FROM loops`).get()).toEqual({ c: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS c FROM loop_iterations`).get()).toEqual({ c: 0 });
    db.close();
  });
});
