import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, applyMigrations } from '../../index.js';

describe('migration 0002: add pid column', () => {
  it('adds pid column to runs table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-orch-mig-'));
    const db = openDatabase(join(dir, 'db.sqlite'));
    applyMigrations(db);
    const tableInfo = db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>;
    const pidCol = tableInfo.find((c) => c.name === 'pid');
    expect(pidCol).toBeDefined();
    db.close();
  });

  it('is idempotent when run twice', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-orch-mig-'));
    const db = openDatabase(join(dir, 'db.sqlite'));
    applyMigrations(db);
    applyMigrations(db);
    // Idempotent — no error on second apply.
    db.close();
  });
});
