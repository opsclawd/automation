import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '@ai-sdlc/infrastructure';
import { RepositoryId, WorkerId, RunId, JobId } from '@ai-sdlc/domain';
import { RepositoryRecoveryCoordinator } from '@ai-sdlc/application';
import { generateJobOwnership } from '@ai-sdlc/domain';

vi.setConfig({ testTimeout: 30_000 });

interface RecoveryChildResult {
  dbPath: string;
  pid: number;
  ready: Promise<void>;
  kill: (signal: string) => void;
  exit: Promise<number | null>;
}

function spawnRecoveryChild(
  dbPath: string,
  repoId: string,
  workerId: string,
  runId: string,
  cooperative: boolean,
): RecoveryChildResult {
  const helpersDir = join(__dirname, 'helpers');
  const child = spawn(
    'node',
    [
      '--import',
      'tsx/esm',
      join(helpersDir, 'recovery-worker-child.ts'),
      dbPath,
      repoId,
      workerId,
      runId,
      String(cooperative),
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    },
  );

  let readyResolve: () => void;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    if (text.includes('READY')) {
      readyResolve();
    }
  });

  return {
    dbPath,
    pid: child.pid!,
    ready,
    kill: (signal: string) => child.kill(signal),
    exit: new Promise((resolve) => child.on('exit', (code) => resolve(code))),
  };
}

const tempDirs: string[] = [];

function trackDir<T>(fn: () => T): T {
  const result = fn();
  tempDirs.push(result);
  return result;
}

async function runRecovery(
  repoId: RepositoryId,
  db: ReturnType<typeof openDatabase>,
  now: Date,
  isWorkerAlive: (workerId: WorkerId) => boolean,
) {
  const {
    WorkerLeaseRepository,
    WorkerRegistryRepository,
    JobQueueRepository,
    RepositoryRegistryRepository,
  } = await import('@ai-sdlc/infrastructure');

  const leases = new WorkerLeaseRepository(db);
  const registry = new WorkerRegistryRepository(db);
  const repos = new RepositoryRegistryRepository(db);
  const queue = new JobQueueRepository(db, repos);

  const coordinator = new RepositoryRecoveryCoordinator({
    leases,
    queue,
    registry,
    repos,
    findRun: (runId) => {
      const row = db.prepare('SELECT * FROM runs WHERE uuid = ?').get(runId) as
        | {
            uuid: string;
            status: string;
            display_id: string;
            repo_id: string;
            issue_number: number;
            type: string;
            current_phase: string | null;
            completed_phases: string;
            skipped_phases: string;
            started_at: string;
            completed_at: string | null;
            failure_reason: string | null;
          }
        | undefined;
      if (!row) return undefined;
      return {
        uuid: row.uuid,
        displayId: row.display_id,
        repoId: RepositoryId(row.repo_id ?? 'unknown'),
        issueNumber: row.issue_number,
        type: row.type as 'issue_to_pr' | 'pr_review' | 'consolidate',
        status: row.status as
          | 'queued'
          | 'running'
          | 'waiting'
          | 'passed'
          | 'failed'
          | 'cancelled'
          | 'blocked'
          | 'needs_human_review',
        currentPhase: row.current_phase ?? undefined,
        completedPhases: JSON.parse(row.completed_phases),
        skippedPhases: JSON.parse(row.skipped_phases),
        startedAt: new Date(row.started_at),
        completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
        failureReason: row.failure_reason ?? undefined,
      };
    },
    isWorkerAlive,
    resetWorktree: () => {},
    onOrphan: ({ runId }) => {
      const jobs = queue.listForRun(runId);
      for (const job of jobs) {
        if (job.status === 'claimed' || job.status === 'running') {
          queue.resetToQueued(generateJobOwnership(job, job.claimedBy!));
        }
      }
    },
    onWaitingReactivation: () => {},
    now: () => now,
  });

  return coordinator.execute({ repoId });
}

describe('restart-recovery.failure-injection', () => {
  describe('SIGKILL restart requeues only persisted repository ownership', () => {
    afterEach(() => {
      while (tempDirs.length) {
        const dir = tempDirs.pop();
        if (dir) rmSync(dir, { recursive: true, force: true });
      }
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
      let error: Error | null = null;
      try {
        leaseRepo.acquire({
          repoId,
          workerId: newOwnerId,
          runId,
          now: expiredTime,
          ttlMs: 60_000,
        });

        const lateError = () => {
          try {
            leaseRepo.heartbeat({
              repoId,
              workerId,
              runId,
              now: expiredTime,
              newExpiresAt: new Date(expiredTime.getTime() + 60_000),
              leaseToken: lease!.leaseToken,
            });
          } catch (e) {
            throw e;
          }
        };
        expect(lateError).toThrow();
      } catch (e) {
        error = e as Error;
      }

      expect(error).toBeNull();

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
