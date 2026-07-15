import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { RepositoryId, WorkerId } from '@ai-sdlc/domain';
import { RepositoryRecoveryCoordinator } from '@ai-sdlc/application';
import { generateJobOwnership } from '@ai-sdlc/domain';
import type { Database } from 'better-sqlite3';

export interface RecoveryChildResult {
  dbPath: string;
  pid: number;
  ready: Promise<void>;
  kill: (signal: string) => void;
  exit: Promise<number | null>;
  stderr?: string[];
}

export function spawnRecoveryChild(
  dbPath: string,
  repoId: string,
  workerId: string,
  runId: string,
  cooperative: boolean,
  captureStderr = false,
): RecoveryChildResult {
  const helpersDir = join(__dirname);
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
  if (captureStderr) {
    child.stderr?.on('data', (d) => stderr.push(d.toString()));
  }

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
    stderr: captureStderr ? stderr : undefined,
  };
}

const tempDirs: string[] = [];

export function trackDir<T>(fn: () => T): T {
  const result = fn();
  tempDirs.push(result);
  return result;
}

export function cleanupTempDirs(): void {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

export async function runRecovery(
  repoId: RepositoryId,
  db: Database,
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
