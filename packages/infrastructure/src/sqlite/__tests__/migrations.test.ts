import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, applyMigrations } from '../../index.js';
import * as init from '../migrations/0001-init.js';
import * as addPid from '../migrations/0002-add-pid-column.js';
import * as agentInvocations from '../migrations/0003-agent-invocations.js';

describe('migrations', () => {
  it('are idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-orch-mig-'));
    const db = openDatabase(join(dir, 'db.sqlite'));
    applyMigrations(db);
    applyMigrations(db);
    const versions = db.prepare('SELECT version FROM schema_version').all();
    expect(versions).toHaveLength(10);
    db.close();
  });

  it('creates agent_invocations table with required columns', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const cols = db.prepare(`PRAGMA table_info('agent_invocations')`).all() as Array<{
      name: string;
    }>;
    const names = cols.map((c) => c.name);
    for (const required of [
      'id',
      'run_uuid',
      'phase_id',
      'step_id',
      'profile',
      'runtime',
      'provider',
      'model',
      'skill',
      'prompt_path',
      'prompt_chars',
      'prompt_tokens_approx',
      'stdout_path',
      'stderr_path',
      'started_at',
      'ended_at',
      'start_commit_sha',
      'end_commit_sha',
      'exit_code',
      'duration_ms',
      'timeout_ms',
      'outcome',
      'contract_violations',
      'result_json_path',
      'fallback_of_invocation_id',
    ]) {
      expect(names).toContain(required);
    }
  });

  it('0004 renames phase_id values across all phase-bearing columns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-orch-mig-'));
    const db = openDatabase(join(dir, 'db.sqlite'));

    // Apply migrations 0001-0003 only, leaving 0004 unapplied so we can
    // seed legacy data and then exercise the real 0004 migration via
    // applyMigrations() rather than reimplementing its SQL inline.
    db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );`);
    db.exec(init.sql);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      init.version,
      new Date().toISOString(),
    );
    db.exec(addPid.sql);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      addPid.version,
      new Date().toISOString(),
    );
    db.exec(agentInvocations.sql);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      agentInvocations.version,
      new Date().toISOString(),
    );

    // Seed legacy data across every phase-bearing column.
    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, started_at, current_phase, completed_phases)
       VALUES ('run-1', 'run-1', 52, 'issue', 'running', datetime('now'), 'review',
               '["plan-design","plan-write","implement","validate","review","pr-review-poll"]')`,
    ).run();

    db.prepare(
      `INSERT INTO agent_invocations
        (id, run_uuid, phase_id, profile, runtime, provider, model, prompt_path, prompt_chars, stdout_path, stderr_path, started_at, start_commit_sha, timeout_ms, contract_violations)
       VALUES
        ('inv-1', 'run-1', 'review', 'd', 'l', 'o', 'm', '/x', 0, '/x', '/x', datetime('now'), '${'0'.repeat(40)}', 1, '[]'),
        ('inv-2', 'run-1', 'pr-review-poll', 'd', 'l', 'o', 'm', '/x', 0, '/x', '/x', datetime('now'), '${'0'.repeat(40)}', 1, '[]'),
        ('inv-3', 'run-1', 'plan-write', 'd', 'l', 'o', 'm', '/x', 0, '/x', '/x', datetime('now'), '${'0'.repeat(40)}', 1, '[]')`,
    ).run();

    db.prepare(
      `INSERT INTO events (run_uuid, phase, level, type, message, timestamp, metadata)
       VALUES ('run-1', 'review', 'info', 'phase.started', 'x', datetime('now'), '{}'),
              ('run-1', 'pr-review-poll', 'info', 'phase.started', 'x', datetime('now'), '{}')`,
    ).run();

    db.prepare(
      `INSERT INTO phases (id, run_uuid, name, status, started_at)
       VALUES ('ph-1', 'run-1', 'review', 'completed', datetime('now')),
              ('ph-2', 'run-1', 'pr-review-poll', 'completed', datetime('now'))`,
    ).run();

    db.prepare(
      `INSERT INTO artifacts (id, run_uuid, phase, type, path, created_at)
       VALUES ('a-1', 'run-1', 'review', 'review', '/tmp/r.md', datetime('now')),
              ('a-2', 'run-1', 'pr-review-poll', 'log', '/tmp/p.log', datetime('now'))`,
    ).run();

    db.prepare(
      `INSERT INTO failures (run_uuid, phase, kind, message, can_retry, suggested_action, detected_at)
       VALUES ('run-1', 'review', 'unknown', 'x', 0, 'retry', datetime('now'))`,
    ).run();

    // Apply migration 0004 via the real applyMigrations() — exercises the
    // actual SQL file, not a reimplementation. If the migration file ever
    // diverges from the assertions below, this test breaks.
    applyMigrations(db);

    // agent_invocations
    expect(
      (
        db.prepare("SELECT phase_id FROM agent_invocations WHERE id = 'inv-1'").get() as {
          phase_id: string;
        }
      ).phase_id,
    ).toBe('whole-pr-review');
    expect(
      (
        db.prepare("SELECT phase_id FROM agent_invocations WHERE id = 'inv-2'").get() as {
          phase_id: string;
        }
      ).phase_id,
    ).toBe('post-pr-review');
    expect(
      (
        db.prepare("SELECT phase_id FROM agent_invocations WHERE id = 'inv-3'").get() as {
          phase_id: string;
        }
      ).phase_id,
    ).toBe('plan-write');

    // events
    const eventPhases = (
      db.prepare('SELECT phase FROM events ORDER BY phase').all() as Array<{ phase: string }>
    ).map((r) => r.phase);
    expect(eventPhases).toEqual(['post-pr-review', 'review-fix']);

    // phases
    const phaseNames = (
      db.prepare('SELECT name FROM phases ORDER BY name').all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(phaseNames).toEqual(['post-pr-review', 'review-fix']);

    // artifacts
    const artifactPhases = (
      db.prepare('SELECT phase FROM artifacts ORDER BY phase').all() as Array<{ phase: string }>
    ).map((r) => r.phase);
    expect(artifactPhases).toEqual(['post-pr-review', 'review-fix']);

    // failures
    expect((db.prepare('SELECT phase FROM failures').get() as { phase: string }).phase).toBe(
      'review-fix',
    );

    // runs.current_phase + runs.completed_phases
    const run = db.prepare('SELECT current_phase, completed_phases FROM runs').get() as {
      current_phase: string;
      completed_phases: string;
    };
    expect(run.current_phase).toBe('review-fix');
    expect(JSON.parse(run.completed_phases)).toEqual([
      'plan-design',
      'plan-write',
      'implement',
      'validate',
      'review-fix',
      'post-pr-review',
    ]);

    db.close();
  });

  it('0010 backfills whole-pr-review and fix-review to review-fix (not agent_invocations, not loops)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-orch-mig-'));
    const db = openDatabase(join(dir, 'db.sqlite'));

    // Apply all migrations to set up the schema.
    applyMigrations(db);

    // Unregister version 10 so applyMigrations will re-run 0010 after seeding.
    db.prepare('DELETE FROM schema_version WHERE version = 10').run();

    // Seed legacy split-phase data into every phase-bearing column.
    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, started_at, current_phase, completed_phases)
       VALUES ('run-rf', 'run-rf', 100, 'issue', 'running', datetime('now'), 'whole-pr-review',
               '["plan-design","implement","validate","whole-pr-review","fix-review","compound"]')`,
    ).run();

    db.prepare(
      `INSERT INTO agent_invocations
        (id, run_uuid, phase_id, profile, runtime, provider, model, prompt_path, prompt_chars, stdout_path, stderr_path, started_at, start_commit_sha, timeout_ms, contract_violations)
       VALUES
        ('inv-rf-1', 'run-rf', 'whole-pr-review', 'd', 'l', 'o', 'm', '/x', 0, '/x', '/x', datetime('now'), '${'0'.repeat(40)}', 1, '[]'),
        ('inv-rf-2', 'run-rf', 'fix-review', 'd', 'l', 'o', 'm', '/x', 0, '/x', '/x', datetime('now'), '${'0'.repeat(40)}', 1, '[]')`,
    ).run();

    db.prepare(
      `INSERT INTO events (run_uuid, phase, level, type, message, timestamp, metadata)
       VALUES ('run-rf', 'whole-pr-review', 'info', 'phase.started', 'x', datetime('now'), '{}'),
              ('run-rf', 'fix-review', 'info', 'phase.done', 'x', datetime('now'), '{}')`,
    ).run();

    db.prepare(
      `INSERT INTO phases (id, run_uuid, name, status, started_at)
       VALUES ('ph-rf-1', 'run-rf', 'whole-pr-review', 'completed', datetime('now')),
              ('ph-rf-2', 'run-rf', 'fix-review', 'completed', datetime('now'))`,
    ).run();

    db.prepare(
      `INSERT INTO artifacts (id, run_uuid, phase, type, path, created_at)
       VALUES ('a-rf-1', 'run-rf', 'whole-pr-review', 'review', '/tmp/r.md', datetime('now')),
              ('a-rf-2', 'run-rf', 'fix-review', 'log', '/tmp/f.log', datetime('now'))`,
    ).run();

    db.prepare(
      `INSERT INTO failures (run_uuid, phase, kind, message, can_retry, suggested_action, detected_at)
       VALUES ('run-rf', 'fix-review', 'agent_blocked', 'x', 0, 'retry', datetime('now'))`,
    ).run();

    db.prepare(
      `INSERT INTO loops (id, run_uuid, phase_id, type, max_iterations, status, started_at)
       VALUES ('loop-rf-1', 'run-rf', 'whole-pr-review', 'review', 5, 'completed', datetime('now')),
              ('loop-rf-2', 'run-rf', 'fix-review', 'fix', 5, 'completed', datetime('now'))`,
    ).run();

    // Apply migration 0010.
    applyMigrations(db);

    // agent_invocations.phase_id must NOT be backfilled (loop-internal routing keys).
    expect(
      (
        db.prepare("SELECT phase_id FROM agent_invocations WHERE id = 'inv-rf-1'").get() as {
          phase_id: string;
        }
      ).phase_id,
    ).toBe('whole-pr-review');
    expect(
      (
        db.prepare("SELECT phase_id FROM agent_invocations WHERE id = 'inv-rf-2'").get() as {
          phase_id: string;
        }
      ).phase_id,
    ).toBe('fix-review');

    // events.phase must be backfilled.
    const eventPhases = (
      db.prepare('SELECT phase FROM events ORDER BY phase').all() as Array<{ phase: string }>
    ).map((r) => r.phase);
    expect(eventPhases).toEqual(['review-fix', 'review-fix']);

    // phases.name must be backfilled.
    const phaseNames = (
      db.prepare('SELECT name FROM phases ORDER BY name').all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(phaseNames).toEqual(['review-fix', 'review-fix']);

    // artifacts.phase must be backfilled.
    const artPhases = (
      db.prepare('SELECT phase FROM artifacts ORDER BY phase').all() as Array<{ phase: string }>
    ).map((r) => r.phase);
    expect(artPhases).toEqual(['review-fix', 'review-fix']);

    // failures.phase must be backfilled.
    expect((db.prepare('SELECT phase FROM failures').get() as { phase: string }).phase).toBe(
      'review-fix',
    );

    // loops.phase_id must NOT be backfilled — the route constructs artifact
    // paths from l.phaseId (review-fix.ts:30-37) and on-disk files for old
    // runs live under the original phase directory name.
    const loopPhaseIds = (
      db.prepare('SELECT phase_id FROM loops ORDER BY phase_id').all() as Array<{
        phase_id: string;
      }>
    ).map((r) => r.phase_id);
    expect(loopPhaseIds).toEqual(['fix-review', 'whole-pr-review']);

    // runs.current_phase + completed_phases must be backfilled.
    const run = db.prepare('SELECT current_phase, completed_phases FROM runs').get() as {
      current_phase: string;
      completed_phases: string;
    };
    expect(run.current_phase).toBe('review-fix');
    expect(JSON.parse(run.completed_phases)).toEqual([
      'plan-design',
      'implement',
      'validate',
      'review-fix',
      'compound',
    ]);

    db.close();
  });
});
