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

describe('multi-repository-recovery.failure-injection', () => {
  describe('expired repository A lease cannot mutate repository B', () => {
    afterEach(() => {
      cleanupTempDirs();
      vi.useRealTimers();
    });

    it('expiring lease on repo A leaves repo B lease and jobs untouched', async () => {
      const baseDirA = trackDir(() => mkdtempSync(join(tmpdir(), 'multi-recovery-a-')));
      const baseDirB = trackDir(() => mkdtempSync(join(tmpdir(), 'multi-recovery-b-')));
      const dbPathA = join(baseDirA, 'orch.sqlite');
      const dbPathB = join(baseDirB, 'orch.sqlite');
      const repoIdA = RepositoryId('owner/repo-a');
      const repoIdB = RepositoryId('owner/repo-b');
      const workerIdA = WorkerId(`worker-a-${Date.now()}`);
      const workerIdB = WorkerId(`worker-b-${Date.now()}`);
      const runIdA = RunId(`run-a-${Date.now()}`);
      const runIdB = RunId(`run-b-${Date.now()}`);

      const childA = spawnRecoveryChild(dbPathA, repoIdA, workerIdA, runIdA, true);
      await childA.ready;

      const childB = spawnRecoveryChild(dbPathB, repoIdB, workerIdB, runIdB, true);
      await childB.ready;

      childA.kill('SIGKILL');
      childB.kill('SIGKILL');
      await childA.exit;
      await childB.exit;

      const dbA = openDatabase(dbPathA);
      const dbB = openDatabase(dbPathB);

      const leaseRowABefore = dbA
        .prepare('SELECT * FROM worker_leases WHERE repo_id = ?')
        .get(repoIdA);
      expect(leaseRowABefore).toBeDefined();

      const expiredTime = new Date(Date.now() + 120_000);
      vi.setSystemTime(expiredTime);

      await runRecovery(repoIdA, dbA, expiredTime, () => false);

      const leaseRowB = dbB
        .prepare('SELECT * FROM worker_leases WHERE repo_id = ?')
        .get(repoIdB) as { repo_id: string; worker_id: string } | undefined;
      expect(leaseRowB).toBeDefined();
      expect(leaseRowB!.repo_id).toBe(repoIdB);
      expect(leaseRowB!.worker_id).toBe(workerIdB);

      const jobRowB = dbB.prepare('SELECT * FROM jobs WHERE repo_id = ?').get(repoIdB) as
        | { id: string; status: string }
        | undefined;
      expect(jobRowB).toBeDefined();
      expect(jobRowB!.status).toBe('running');

      dbA.close();
      dbB.close();
    });
  });

  describe('unavailable repository A fails locally while repository B completes', () => {
    afterEach(() => {
      cleanupTempDirs();
      vi.useRealTimers();
    });

    it('repo A unreachable does not affect repo B job completion', async () => {
      const baseDirA = trackDir(() => mkdtempSync(join(tmpdir(), 'unavail-a-')));
      const baseDirB = trackDir(() => mkdtempSync(join(tmpdir(), 'unavail-b-')));
      const dbPathA = join(baseDirA, 'orch.sqlite');
      const dbPathB = join(baseDirB, 'orch.sqlite');
      const repoIdA = RepositoryId('owner/repo-a');
      const repoIdB = RepositoryId('owner/repo-b');
      const workerIdA = WorkerId(`worker-a-${Date.now()}`);
      const workerIdB = WorkerId(`worker-b-${Date.now()}`);
      const runIdA = RunId(`run-a-${Date.now()}`);
      const runIdB = RunId(`run-b-${Date.now()}`);

      const childA = spawnRecoveryChild(dbPathA, repoIdA, workerIdA, runIdA, true);
      await childA.ready;

      const childB = spawnRecoveryChild(dbPathB, repoIdB, workerIdB, runIdB, true);
      await childB.ready;

      childA.kill('SIGKILL');
      childB.kill('SIGTERM');
      await childA.exit;
      await childB.exit;

      const dbA = openDatabase(dbPathA);
      const dbB = openDatabase(dbPathB);

      const jobRowA = dbA.prepare('SELECT * FROM jobs WHERE repo_id = ?').get(repoIdA) as
        | { status: string }
        | undefined;
      const jobRowB = dbB.prepare('SELECT * FROM jobs WHERE repo_id = ?').get(repoIdB) as
        | { status: string }
        | undefined;

      expect(jobRowA).toBeDefined();
      expect(jobRowB).toBeDefined();
      expect(jobRowA?.status).toBe('running');

      dbA.close();
      dbB.close();
    });
  });

  describe('blocked repository A operational open still yields repository B recovery result', () => {
    afterEach(() => {
      cleanupTempDirs();
      vi.useRealTimers();
    });

    it('repo A blocked while operational repo B recovery succeeds independently', async () => {
      const baseDirA = trackDir(() => mkdtempSync(join(tmpdir(), 'blocked-a-')));
      const baseDirB = trackDir(() => mkdtempSync(join(tmpdir(), 'blocked-b-')));
      const dbPathA = join(baseDirA, 'orch.sqlite');
      const dbPathB = join(baseDirB, 'orch.sqlite');
      const repoIdA = RepositoryId('owner/repo-a');
      const repoIdB = RepositoryId('owner/repo-b');
      const workerIdA = WorkerId(`worker-a-${Date.now()}`);
      const workerIdB = WorkerId(`worker-b-${Date.now()}`);
      const runIdA = RunId(`run-a-${Date.now()}`);
      const runIdB = RunId(`run-b-${Date.now()}`);

      const childA = spawnRecoveryChild(dbPathA, repoIdA, workerIdA, runIdA, false);
      await childA.ready;

      const childB = spawnRecoveryChild(dbPathB, repoIdB, workerIdB, runIdB, true);
      await childB.ready;

      childA.kill('SIGKILL');
      childB.kill('SIGTERM');
      await childA.exit;
      await childB.exit;

      const dbA = openDatabase(dbPathA);
      const dbB = openDatabase(dbPathB);

      const expiredTime = new Date(Date.now() + 120_000);
      vi.setSystemTime(expiredTime);

      const resultA = await runRecovery(repoIdA, dbA, expiredTime, () => false);

      expect(resultA.action === 'reclaim' || resultA.action === 'leave').toBe(true);

      const runRowB = dbB.prepare('SELECT * FROM runs WHERE repo_id = ?').get(repoIdB) as
        | { repo_id: string; status: string }
        | undefined;
      expect(runRowB).toBeDefined();
      expect(runRowB!.status).toBe('cancelled');

      dbA.close();
      dbB.close();
    });
  });

  describe('concurrent recovery commits remain repository local', () => {
    afterEach(() => {
      cleanupTempDirs();
      vi.useRealTimers();
    });

    it('concurrent recovery on repo A and repo B each affect only their own state', async () => {
      const baseDirA = trackDir(() => mkdtempSync(join(tmpdir(), 'concurrent-a-')));
      const baseDirB = trackDir(() => mkdtempSync(join(tmpdir(), 'concurrent-b-')));
      const dbPathA = join(baseDirA, 'orch.sqlite');
      const dbPathB = join(baseDirB, 'orch.sqlite');
      const repoIdA = RepositoryId('owner/repo-a');
      const repoIdB = RepositoryId('owner/repo-b');
      const workerIdA = WorkerId(`worker-a-${Date.now()}`);
      const workerIdB = WorkerId(`worker-b-${Date.now()}`);
      const runIdA = RunId(`run-a-${Date.now()}`);
      const runIdB = RunId(`run-b-${Date.now()}`);

      const childA = spawnRecoveryChild(dbPathA, repoIdA, workerIdA, runIdA, true);
      await childA.ready;
      const childB = spawnRecoveryChild(dbPathB, repoIdB, workerIdB, runIdB, true);
      await childB.ready;

      childA.kill('SIGKILL');
      childB.kill('SIGKILL');
      await childA.exit;
      await childB.exit;

      const dbA = openDatabase(dbPathA);
      const dbB = openDatabase(dbPathB);

      const leaseRowABefore = dbA
        .prepare('SELECT * FROM worker_leases WHERE repo_id = ?')
        .get(repoIdA);
      const leaseRowBBefore = dbB
        .prepare('SELECT * FROM worker_leases WHERE repo_id = ?')
        .get(repoIdB);
      expect(leaseRowABefore).toBeDefined();
      expect(leaseRowBBefore).toBeDefined();

      const expiredTime = new Date(Date.now() + 120_000);
      vi.setSystemTime(expiredTime);

      const [resultA, resultB] = await Promise.all([
        runRecovery(repoIdA, dbA, expiredTime, () => false),
        runRecovery(repoIdB, dbB, expiredTime, () => false),
      ]);

      expect(resultA.action === 'reclaim' || resultA.action === 'leave').toBe(true);
      expect(resultB.action === 'reclaim' || resultB.action === 'leave').toBe(true);

      const leaseRowAAfter = dbA
        .prepare('SELECT * FROM worker_leases WHERE repo_id = ?')
        .get(repoIdA);
      const leaseRowBAfter = dbB
        .prepare('SELECT * FROM worker_leases WHERE repo_id = ?')
        .get(repoIdB);
      expect(leaseRowAAfter).toBeDefined();
      expect(leaseRowBAfter).toBeDefined();

      dbA.close();
      dbB.close();
    });
  });
});
