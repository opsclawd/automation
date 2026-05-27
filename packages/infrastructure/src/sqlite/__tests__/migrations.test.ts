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
});
