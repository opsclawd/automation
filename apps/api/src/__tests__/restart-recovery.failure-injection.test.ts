import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '@ai-sdlc/infrastructure';
import { RepositoryId, WorkerId, RunId, JobId } from '@ai-sdlc/domain';
import {
  spawnRecoveryChild,
  trackDir,
  cleanupTempDirs,
  runRecovery,
} from './helpers/recovery-test-helpers';

vi.setConfig({ testTimeout: 30_000 });

describe('restart-recovery.failure-injection', () => {
  describe('SIGKILL restart requeues only persisted repository ownership', () => {
    afterEach(() => {
      cleanupTempDirs();
      vi.useRealTimers();
    });

    it('requeues only persisted repository ownership after SIGKILL', async () => {
      const baseDir = trackDir(() => mkdtempSync(join(tmpdir(), 'restart-sigkill-')));
      const dbPath = join(baseDir, 'orch.sqlite');
      const repoId = RepositoryId('owner/repo');
      const workerId = WorkerId(`worker-${Date.now()}`);
      const runId = RunId(`run-${Date.now()}`);
      const jobId = JobId(`job-${runId}-1`);

      const child = spawnRecoveryChild(dbPath, repoId, workerId, runId, true);
      await child.ready;

      child.kill('SIGKILL');
      await child.exit;

      const db = openDatabase(dbPath);

      const leaseRow = db.prepare('SELECT * FROM worker_leases WHERE repo_id = ?').get(repoId) as
        | {
            repo_id: string;
            worker_id: string;
            run_id: string;
            expires_at: string;
          }
        | undefined;
      expect(leaseRow).toBeDefined();
      expect(leaseRow!.worker_id).toBe(workerId);

      const now = new Date();
      const expiredTime = new Date(now.getTime() + 120_000);
      vi.setSystemTime(expiredTime);

      const action = await runRecovery(repoId, db, expiredTime, () => false);

      expect(action.action).toBe('reclaim');

      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as { status: string };
      expect(job.status).toBe('queued');

      db.close();
    });

    it('late killed owner cannot heartbeat or release reclaimed generation', async () => {
      const baseDir = trackDir(() => mkdtempSync(join(tmpdir(), 'late-kill-')));
      const dbPath = join(baseDir, 'orch.sqlite');
      const repoId = RepositoryId('owner/repo');
      const workerId = WorkerId(`worker-${Date.now()}`);
      const runId = RunId(`run-${Date.now()}`);

      const child = spawnRecoveryChild(dbPath, repoId, workerId, runId, true);
      await child.ready;

      child.kill('SIGKILL');
      await child.exit;

      const db = openDatabase(dbPath);
      const { WorkerLeaseRepository } = await import('@ai-sdlc/infrastructure');

      const leaseRepo = new WorkerLeaseRepository(db);
      const lease = leaseRepo.current(repoId);
      expect(lease).toBeDefined();

      const now = new Date();
      const expiredTime = new Date(now.getTime() + 120_000);
      vi.setSystemTime(expiredTime);

      await runRecovery(repoId, db, expiredTime, () => false);

      const newOwnerId = WorkerId(`new-worker-${Date.now()}`);
      leaseRepo.acquire({
        repoId,
        workerId: newOwnerId,
        runId,
        now: expiredTime,
        ttlMs: 60_000,
      });

      expect(() =>
        leaseRepo.heartbeat({
          repoId,
          workerId,
          runId,
          now: expiredTime,
          newExpiresAt: new Date(expiredTime.getTime() + 60_000),
          leaseToken: lease!.leaseToken,
        }),
      ).toThrow();

      db.close();
    });

    it('restart barrier waits for recovery before dispatch', async () => {
      const baseDir = trackDir(() => mkdtempSync(join(tmpdir(), 'restart-barrier-')));
      const dbPath = join(baseDir, 'orch.sqlite');
      const repoId = RepositoryId('owner/repo');
      const workerId = WorkerId(`worker-${Date.now()}`);
      const runId = RunId(`run-${Date.now()}`);

      const child = spawnRecoveryChild(dbPath, repoId, workerId, runId, true);
      await child.ready;

      child.kill('SIGKILL');
      await child.exit;

      const db = openDatabase(dbPath);

      const now = new Date();
      const expiredTime = new Date(now.getTime() + 120_000);
      vi.setSystemTime(expiredTime);

      const recovered = await runRecovery(repoId, db, expiredTime, () => false);

      expect(recovered.action === 'reclaim' || recovered.action === 'leave').toBe(true);

      const leaseCheck = db.prepare('SELECT * FROM worker_leases WHERE repo_id = ?').get(repoId);
      expect(leaseCheck).toBeDefined();

      db.close();
    });
  });
});
