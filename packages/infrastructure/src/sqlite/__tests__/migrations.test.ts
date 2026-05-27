import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, applyMigrations } from '../../index.js';

describe('migrations', () => {
  it('are idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-orch-mig-'));
    const db = openDatabase(join(dir, 'db.sqlite'));
    applyMigrations(db);
    applyMigrations(db);
    const versions = db.prepare('SELECT version FROM schema_version').all();
    expect(versions).toHaveLength(4);
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

  it('0004 renames phase_id values correctly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-orch-mig-'));
    const db = openDatabase(join(dir, 'db.sqlite'));
    applyMigrations(db);

    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, started_at) VALUES ('run-1', 'run-1', 52, 'issue', 'running', datetime('now'))`,
    ).run();

    db.prepare(
      `
      INSERT INTO agent_invocations
        (id, run_uuid, phase_id, profile, runtime, provider, model, prompt_path, prompt_chars, stdout_path, stderr_path, started_at, start_commit_sha, timeout_ms, contract_violations)
      VALUES
        ('inv-reivew-1', 'run-1', 'review', 'default', 'local', 'opencode', 'mini', '/dev/null', 0, '/dev/null', '/dev/null', datetime('now'), '0000000000000000000000000000000000000000', 300000, '[]'),
        ('inv-reivew-2', 'run-1', 'review', 'default', 'local', 'opencode', 'mini', '/dev/null', 0, '/dev/null', '/dev/null', datetime('now'), '0000000000000000000000000000000000000000', 300000, '[]'),
        ('inv-prpoll-1', 'run-1', 'pr-review-poll', 'default', 'local', 'opencode', 'mini', '/dev/null', 0, '/dev/null', '/dev/null', datetime('now'), '0000000000000000000000000000000000000000', 300000, '[]'),
        ('inv-prpoll-2', 'run-1', 'pr-review-poll', 'default', 'local', 'opencode', 'mini', '/dev/null', 0, '/dev/null', '/dev/null', datetime('now'), '0000000000000000000000000000000000000000', 300000, '[]'),
        ('inv-other-1', 'run-1', 'plan-write', 'default', 'local', 'opencode', 'mini', '/dev/null', 0, '/dev/null', '/dev/null', datetime('now'), '0000000000000000000000000000000000000000', 300000, '[]')
    `,
    ).run();

    const beforeReview = db
      .prepare("SELECT phase_id FROM agent_invocations WHERE id = 'inv-reivew-1'")
      .get() as { phase_id: string };
    const beforePrpoll = db
      .prepare("SELECT phase_id FROM agent_invocations WHERE id = 'inv-prpoll-1'")
      .get() as { phase_id: string };
    expect(beforeReview.phase_id).toBe('review');
    expect(beforePrpoll.phase_id).toBe('pr-review-poll');

    db.exec(`
      UPDATE agent_invocations SET phase_id = 'whole-pr-review' WHERE phase_id = 'review';
      UPDATE agent_invocations SET phase_id = 'post-pr-review' WHERE phase_id = 'pr-review-poll';
    `);

    const afterReview = db
      .prepare("SELECT phase_id FROM agent_invocations WHERE id = 'inv-reivew-1'")
      .get() as { phase_id: string };
    const afterPrpoll = db
      .prepare("SELECT phase_id FROM agent_invocations WHERE id = 'inv-prpoll-1'")
      .get() as { phase_id: string };
    const afterOther = db
      .prepare("SELECT phase_id FROM agent_invocations WHERE id = 'inv-other-1'")
      .get() as { phase_id: string };
    expect(afterReview.phase_id).toBe('whole-pr-review');
    expect(afterPrpoll.phase_id).toBe('post-pr-review');
    expect(afterOther.phase_id).toBe('plan-write');

    db.close();
  });
});
