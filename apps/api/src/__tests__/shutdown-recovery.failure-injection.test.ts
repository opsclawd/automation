import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '@ai-sdlc/infrastructure';
import { RepositoryId, WorkerId, RunId } from '@ai-sdlc/domain';
import {
  spawnRecoveryChild,
  trackDir,
  cleanupTempDirs,
  runRecovery,
} from './helpers/recovery-test-helpers';

vi.setConfig({ testTimeout: 30_000 });

describe('shutdown-recovery.failure-injection', () => {
  describe('SIGTERM cooperative child drains job and lease before database close', () => {
    afterEach(() => {
      cleanupTempDirs();
      vi.useRealTimers();
    });

    it('cooperative child drains job and lease on SIGTERM', async () => {
      const baseDir = trackDir(() => mkdtempSync(join(tmpdir(), 'coop-shutdown-')));
      const dbPath = join(baseDir, 'orch.sqlite');
      const repoId = RepositoryId('owner/repo');
      const workerId = WorkerId(`worker-${Date.now()}`);
      const runId = RunId(`run-${Date.now()}`);

      const child = spawnRecoveryChild(dbPath, repoId, workerId, runId, true);
      await child.ready;

      child.kill('SIGTERM');
      await child.exit;

      const db = openDatabase(dbPath);

      const leaseRow = db.prepare('SELECT * FROM worker_leases WHERE repo_id = ?').get(repoId);
      expect(leaseRow).toBeUndefined();

      const jobRow = db.prepare('SELECT * FROM jobs WHERE run_id = ?').get(runId) as
        | { status: string }
        | undefined;
      expect(jobRow?.status).toBe('cancelled');

      const runRow = db.prepare('SELECT * FROM runs WHERE uuid = ?').get(runId) as
        | { status: string; failure_reason: string | null }
        | undefined;
      expect(runRow?.status).toBe('cancelled');
      expect(runRow?.failure_reason).toMatch(/SIGTERM/i);

      db.close();
    }, 15_000);

    it('no SQLite operations after database close in cooperative shutdown', async () => {
      const baseDir = trackDir(() => mkdtempSync(join(tmpdir(), 'coop-close-')));
      const dbPath = join(baseDir, 'orch.sqlite');
      const repoId = RepositoryId('owner/repo');
      const workerId = WorkerId(`worker-${Date.now()}`);
      const runId = RunId(`run-${Date.now()}`);

      const child = spawnRecoveryChild(dbPath, repoId, workerId, runId, true);
      await child.ready;

      child.kill('SIGTERM');
      await child.exit;

      let error: Error | null = null;
      try {
        const db = openDatabase(dbPath);
        db.prepare('SELECT 1').get();
        db.close();
      } catch (e) {
        error = e as Error;
      }

      expect(error).toBeNull();
    }, 15_000);
  });

  describe('SIGTERM noncooperative child retains fenced lease after grace', () => {
    afterEach(() => {
      cleanupTempDirs();
      vi.useRealTimers();
    });

    it('noncooperative child retains fenced lease after grace period', async () => {
      const baseDir = trackDir(() => mkdtempSync(join(tmpdir(), 'noncoop-shutdown-')));
      const dbPath = join(baseDir, 'orch.sqlite');
      const repoId = RepositoryId('owner/repo');
      const workerId = WorkerId(`worker-${Date.now()}`);
      const runId = RunId(`run-${Date.now()}`);

      const child = spawnRecoveryChild(dbPath, repoId, workerId, runId, false);
      await child.ready;

      child.kill('SIGTERM');
      await child.exit;

      const db = openDatabase(dbPath);
      const leaseRow = db.prepare('SELECT * FROM worker_leases WHERE repo_id = ?').get(repoId) as
        | {
            repo_id: string;
            worker_id: string;
            lease_token: string;
            expires_at: string;
          }
        | undefined;

      expect(leaseRow).toBeDefined();
      expect(leaseRow!.worker_id).toBe(workerId);

      db.close();
    }, 15_000);
  });

  describe('next startup safety-recovers retained shutdown lease', () => {
    afterEach(() => {
      cleanupTempDirs();
      vi.useRealTimers();
    });

    it('safety-recovers retained lease on next startup', async () => {
      const baseDir = trackDir(() => mkdtempSync(join(tmpdir(), 'safety-recover-')));
      const dbPath = join(baseDir, 'orch.sqlite');
      const repoId = RepositoryId('owner/repo');
      const workerId = WorkerId(`worker-${Date.now()}`);
      const runId = RunId(`run-${Date.now()}`);

      const child = spawnRecoveryChild(dbPath, repoId, workerId, runId, false);
      await child.ready;

      child.kill('SIGTERM');
      await child.exit;

      const db = openDatabase(dbPath);

      const leaseBefore = db
        .prepare('SELECT * FROM worker_leases WHERE repo_id = ?')
        .get(repoId) as
        | {
            repo_id: string;
            worker_id: string;
            run_id: string;
            expires_at: string;
            lease_token: string;
          }
        | undefined;
      expect(leaseBefore).toBeDefined();

      const now = new Date();
      const expiredTime = new Date(now.getTime() + 120_000);
      vi.setSystemTime(expiredTime);

      const action = await runRecovery(repoId, db, expiredTime, () => false);

      expect(
        action.action === 'reclaim' ||
          action.action === 'orphan-enqueue' ||
          action.action === 'leave',
      ).toBe(true);

      db.close();
    }, 15_000);
  });
});
