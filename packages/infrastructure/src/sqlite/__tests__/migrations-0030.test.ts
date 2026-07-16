import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, MIGRATIONS } from '../../index.js';

function buildDbAtVersion29() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-m30-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  db.function('sha256', (val: string) => createHash('sha256').update(val).digest());
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);
  for (const m of MIGRATIONS.filter((x) => x.version <= 29)) {
    db.exec(m.sql);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      m.version,
      new Date().toISOString(),
    );
  }
  return db;
}

describe('migration 0030 — fence worker leases', () => {
  it('migration backfills active lease ownership generations', () => {
    const db = buildDbAtVersion29();

    // Insert an active lease at version 29 (which does not have lease_token column)
    const now = new Date('2026-01-01T00:00:00Z').toISOString();
    const exp = new Date('2026-01-01T00:01:00Z').toISOString();
    db.prepare(
      `INSERT INTO worker_leases (repo_id, worker_id, run_id, acquired_at, heartbeat_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('repo-a', 'w1', 'run-1', now, now, exp);

    // Apply migration 30
    const m30 = MIGRATIONS.find((m) => m.version === 30);
    expect(m30).toBeDefined();
    db.exec(m30!.sql);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      m30!.version,
      new Date().toISOString(),
    );

    // Assert that the lease_token is added and is a non-empty string
    const row = db.prepare(`SELECT * FROM worker_leases WHERE repo_id = 'repo-a'`).get() as Record<
      string,
      unknown
    >;
    expect(row).toBeDefined();
    expect(row.lease_token).toBeTypeOf('string');
    expect(String(row.lease_token).length).toBeGreaterThan(0);

    // Check table info to verify notnull constraint
    const columns = db.prepare(`PRAGMA table_info(worker_leases)`).all() as Array<{
      name: string;
      notnull: number;
    }>;
    const leaseTokenCol = columns.find((c) => c.name === 'lease_token');
    expect(leaseTokenCol).toBeDefined();
    expect(leaseTokenCol!.notnull).toBe(1);

    // Check idx_worker_leases_fence
    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = 'worker_leases'`)
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain('idx_worker_leases_fence');

    db.close();
  });
});
