import { describe, expect, it } from 'vitest';
import { openDatabase, applyMigrations } from '../../index.js';

describe('migration 0005 validation tables', () => {
  it('creates validation_runs with required columns', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const names = (
      db.prepare(`PRAGMA table_info('validation_runs')`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    for (const required of ['id', 'run_uuid', 'phase_id', 'started_at', 'completed_at']) {
      expect(names).toContain(required);
    }
    db.close();
  });

  it('creates validation_command_results with required columns', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const names = (
      db.prepare(`PRAGMA table_info('validation_command_results')`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    for (const required of [
      'id',
      'validation_run_id',
      'ordinal',
      'command',
      'exit_code',
      'duration_ms',
      'stdout_path',
      'stderr_path',
      'outcome',
      'kind',
      'classifier',
    ]) {
      expect(names).toContain(required);
    }
    db.close();
  });

  it('reaches schema version 5 and is idempotent', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    applyMigrations(db);
    const versions = db.prepare('SELECT version FROM schema_version').all();
    expect(versions).toHaveLength(13);
    db.close();
  });
});
