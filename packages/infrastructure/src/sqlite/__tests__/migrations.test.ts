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
    expect(versions).toHaveLength(3);
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
      'profile',
      'runtime',
      'provider',
      'model',
      'prompt_chars',
      'started_at',
      'ended_at',
      'timeout_ms',
      'outcome',
      'contract_violations',
      'fallback_of_invocation_id',
    ]) {
      expect(names).toContain(required);
    }
  });
});
