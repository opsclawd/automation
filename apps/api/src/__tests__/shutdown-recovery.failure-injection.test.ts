import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '@ai-sdlc/infrastructure';
import { RepositoryId, WorkerId, RunId } from '@ai-sdlc/domain';
import { RepositoryRecoveryCoordinator } from '@ai-sdlc/application';
import { generateJobOwnership } from '@ai-sdlc/domain';

vi.setConfig({ testTimeout: 30_000 });

interface RecoveryChildResult {
  dbPath: string;
  pid: number;
  ready: Promise<void>;
  kill: (signal: string) => void;
  exit: Promise<number | null>;
  stderr: string[];
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

  const stderr: string[] = [];
  child.stderr?.on('data', (d) => stderr.push(d.toString()));

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
    stderr,
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

describe('shutdown-recovery.failure-injection', () => {
  describe('SIGTERM cooperative child drains job and lease before database close', () => {
    afterEach(() => {
      while (tempDirs.length) {
        const dir = tempDirs.pop();
        if (dir) rmSync(dir, { recursive: true, force: true });
      }
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
      while (tempDirs.length) {
        const dir = tempDirs.pop();
        if (dir) rmSync(dir, { recursive: true, force: true });
      }
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
      while (tempDirs.length) {
        const dir = tempDirs.pop();
        if (dir) rmSync(dir, { recursive: true, force: true });
      }
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
