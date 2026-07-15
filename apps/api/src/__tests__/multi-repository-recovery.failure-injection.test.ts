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

vi.setConfig({ testTimeout: 120_000 });

describe('multi-repository-recovery.failure-injection', () => {
  describe('expired repository A lease cannot mutate repository B', () => {
    afterEach(() => {
      cleanupTempDirs();
      vi.useRealTimers();
    });

    it('expiring lease on repo A leaves repo B lease and jobs untouched', async () => {
      const baseDir = trackDir(() => mkdtempSync(join(tmpdir(), 'multi-recovery-')));
      const dbPath = join(baseDir, 'orch.sqlite');
      const repoIdA = RepositoryId('owner/repo-a');
      const repoIdB = RepositoryId('owner/repo-b');
      const workerIdA = WorkerId(`worker-a-${Date.now()}`);
      const workerIdB = WorkerId(`worker-b-${Date.now()}`);
      const runIdA = RunId(`run-a-${Math.random().toString(36).substring(2, 8)}`);
      const runIdB = RunId(`run-b-${Math.random().toString(36).substring(2, 8)}`);

      const childA = spawnRecoveryChild(dbPath, repoIdA, workerIdA, runIdA, true);
      await childA.ready;

      const childB = spawnRecoveryChild(dbPath, repoIdB, workerIdB, runIdB, true);
      await childB.ready;

      childB.kill('SIGKILL');
      await childB.exit;
      childA.kill('SIGKILL');
      await childA.exit;

      const db = openDatabase(dbPath);

      const leaseRowABefore = db
        .prepare('SELECT * FROM worker_leases WHERE repo_id = ?')
        .get(repoIdA);
      expect(leaseRowABefore).toBeDefined();

      const expiredTime = new Date(Date.now() + 120_000);
      vi.setSystemTime(expiredTime);

      await runRecovery(repoIdA, db, expiredTime, () => false);

      const leaseRowB = db.prepare('SELECT * FROM worker_leases WHERE repo_id = ?').get(repoIdB) as
        | { repo_id: string; worker_id: string }
        | undefined;
      expect(leaseRowB).toBeDefined();
      expect(leaseRowB!.repo_id).toBe(repoIdB);
      expect(leaseRowB!.worker_id).toBe(workerIdB);

      const jobRowB = db.prepare('SELECT * FROM jobs WHERE repo_id = ?').get(repoIdB) as
        | { id: string; status: string }
        | undefined;
      expect(jobRowB).toBeDefined();
      expect(jobRowB!.status).toBe('running');

      db.close();
    });
  });

  describe('unavailable repository A fails locally while repository B completes', () => {
    afterEach(() => {
      cleanupTempDirs();
      vi.useRealTimers();
    });

    it('repo A unreachable does not affect repo B job completion', async () => {
      const baseDir = trackDir(() => mkdtempSync(join(tmpdir(), 'unavail-')));
      const dbPath = join(baseDir, 'orch.sqlite');
      const repoIdA = RepositoryId('owner/repo-a');
      const repoIdB = RepositoryId('owner/repo-b');
      const workerIdA = WorkerId(`worker-a-${Date.now()}`);
      const workerIdB = WorkerId(`worker-b-${Date.now()}`);
      const runIdA = RunId(`run-a-${Math.random().toString(36).substring(2, 8)}`);
      const runIdB = RunId(`run-b-${Math.random().toString(36).substring(2, 8)}`);

      const childA = spawnRecoveryChild(dbPath, repoIdA, workerIdA, runIdA, true);
      await childA.ready;

      const childB = spawnRecoveryChild(dbPath, repoIdB, workerIdB, runIdB, true);
      await childB.ready;

      childB.kill('SIGTERM');
      await childB.exit;
      childA.kill('SIGKILL');
      await childA.exit;

      const db = openDatabase(dbPath);

      const expiredTime = new Date(Date.now() + 120_000);
      vi.setSystemTime(expiredTime);

      const [resultA, resultB] = await Promise.all([
        runRecovery(repoIdA, db, expiredTime, () => false),
        runRecovery(repoIdB, db, expiredTime, () => false),
      ]);

      expect(resultA.action === 'reclaim' || resultA.action === 'leave').toBe(true);
      expect(
        resultB.action === 'reclaim' || resultB.action === 'requeue' || resultB.action === 'leave',
      ).toBe(true);

      const jobRowA = db.prepare('SELECT * FROM jobs WHERE repo_id = ?').get(repoIdA) as
        | { status: string }
        | undefined;
      const jobRowB = db.prepare('SELECT * FROM jobs WHERE repo_id = ?').get(repoIdB) as
        | { status: string }
        | undefined;

      expect(jobRowA).toBeDefined();
      expect(jobRowB).toBeDefined();

      db.close();
    });
  });

  describe('blocked repository A operational open still yields repository B recovery result', () => {
    afterEach(() => {
      cleanupTempDirs();
      vi.useRealTimers();
    });

    it('repo A blocked while operational repo B recovery succeeds independently', async () => {
      const baseDir = trackDir(() => mkdtempSync(join(tmpdir(), 'blocked-')));
      const dbPath = join(baseDir, 'orch.sqlite');
      const repoIdA = RepositoryId('owner/repo-a');
      const repoIdB = RepositoryId('owner/repo-b');
      const workerIdA = WorkerId(`worker-a-${Date.now()}`);
      const workerIdB = WorkerId(`worker-b-${Date.now()}`);
      const runIdA = RunId(`run-a-${Math.random().toString(36).substring(2, 8)}`);
      const runIdB = RunId(`run-b-${Math.random().toString(36).substring(2, 8)}`);

      const childA = spawnRecoveryChild(dbPath, repoIdA, workerIdA, runIdA, false);
      await childA.ready;

      const childB = spawnRecoveryChild(dbPath, repoIdB, workerIdB, runIdB, true);
      await childB.ready;

      childA.kill('SIGKILL');
      await childA.exit;
      childB.kill('SIGTERM');
      await childB.exit;

      const db = openDatabase(dbPath);

      const expiredTime = new Date(Date.now() + 120_000);
      vi.setSystemTime(expiredTime);

      const resultA = await runRecovery(repoIdA, db, expiredTime, () => false);

      expect(resultA.action === 'reclaim' || resultA.action === 'leave').toBe(true);

      const resultB = await runRecovery(repoIdB, db, expiredTime, () => false);

      expect(
        resultB.action === 'reclaim' || resultB.action === 'requeue' || resultB.action === 'leave',
      ).toBe(true);

      const runRowB = db.prepare('SELECT * FROM runs WHERE repo_id = ?').get(repoIdB) as
        | { repo_id: string; status: string }
        | undefined;
      expect(runRowB).toBeDefined();
      expect(runRowB!.status).toBe('cancelled');

      db.close();
    });
  });

  describe('concurrent recovery commits remain repository local', () => {
    afterEach(() => {
      cleanupTempDirs();
      vi.useRealTimers();
    });

    it('concurrent recovery on repo A and repo B each affect only their own state', async () => {
      const baseDir = trackDir(() => mkdtempSync(join(tmpdir(), 'concurrent-')));
      const dbPath = join(baseDir, 'orch.sqlite');
      const repoIdA = RepositoryId('owner/repo-a');
      const repoIdB = RepositoryId('owner/repo-b');
      const workerIdA = WorkerId(`worker-a-${Date.now()}`);
      const workerIdB = WorkerId(`worker-b-${Date.now()}`);
      const runIdA = RunId(`run-a-${Math.random().toString(36).substring(2, 8)}`);
      const runIdB = RunId(`run-b-${Math.random().toString(36).substring(2, 8)}`);

      const childA = spawnRecoveryChild(dbPath, repoIdA, workerIdA, runIdA, true);
      await childA.ready;
      const childB = spawnRecoveryChild(dbPath, repoIdB, workerIdB, runIdB, true);
      await childB.ready;

      childB.kill('SIGKILL');
      await childB.exit;
      childA.kill('SIGKILL');
      await childA.exit;

      const db = openDatabase(dbPath);

      const leaseRowABefore = db
        .prepare('SELECT * FROM worker_leases WHERE repo_id = ?')
        .get(repoIdA);
      const leaseRowBBefore = db
        .prepare('SELECT * FROM worker_leases WHERE repo_id = ?')
        .get(repoIdB);
      expect(leaseRowABefore).toBeDefined();
      expect(leaseRowBBefore).toBeDefined();

      const expiredTime = new Date(Date.now() + 120_000);
      vi.setSystemTime(expiredTime);

      const [resultA, resultB] = await Promise.all([
        runRecovery(repoIdA, db, expiredTime, () => false),
        runRecovery(repoIdB, db, expiredTime, () => false),
      ]);

      expect(resultA.action === 'reclaim' || resultA.action === 'leave').toBe(true);
      expect(resultB.action === 'reclaim' || resultB.action === 'leave').toBe(true);

      const leaseRowAAfter = db
        .prepare('SELECT * FROM worker_leases WHERE repo_id = ?')
        .get(repoIdA);
      const leaseRowBAfter = db
        .prepare('SELECT * FROM worker_leases WHERE repo_id = ?')
        .get(repoIdB);
      expect(leaseRowAAfter).toBeUndefined();
      expect(leaseRowBAfter).toBeUndefined();

      db.close();
    });
  });
});
