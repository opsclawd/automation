import {
  type RepositoryId,
  type WorkerId,
  type WorkerLease,
  WorkerLeaseConflictError,
  RepositoryId as mkRepositoryId,
  WorkerId as mkWorkerId,
  RunId,
} from '@ai-sdlc/domain';
import type {
  WorkerLeasePort,
  AcquireLeaseInput,
  ReclaimExpiredInput,
} from '@ai-sdlc/application/ports';
import Database from 'better-sqlite3';
import type { Db } from './database.js';

interface WorkerLeaseRow {
  repo_id: string;
  worker_id: string;
  run_id: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
}

function toWorkerLease(row: WorkerLeaseRow): WorkerLease {
  return {
    repoId: mkRepositoryId(row.repo_id),
    workerId: mkWorkerId(row.worker_id),
    runId: RunId(row.run_id),
    acquiredAt: new Date(row.acquired_at),
    heartbeatAt: new Date(row.heartbeat_at),
    expiresAt: new Date(row.expires_at),
  };
}

export class WorkerLeaseRepository implements WorkerLeasePort {
  constructor(private readonly db: Db) {}

  acquire(input: AcquireLeaseInput): WorkerLease {
    const expiresAt = new Date(input.now.getTime() + input.ttlMs);
    try {
      this.db
        .prepare(
          `INSERT INTO worker_leases (repo_id, worker_id, run_id, acquired_at, heartbeat_at, expires_at)
           VALUES (@repo_id, @worker_id, @run_id, @acquired_at, @heartbeat_at, @expires_at)`,
        )
        .run({
          repo_id: input.repoId,
          worker_id: input.workerId,
          run_id: input.runId,
          acquired_at: input.now.toISOString(),
          heartbeat_at: input.now.toISOString(),
          expires_at: expiresAt.toISOString(),
        });
    } catch (err: unknown) {
      if (err instanceof Database.SqliteError && err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
        const existing = this.current(input.repoId);
        throw new WorkerLeaseConflictError(input.repoId, existing?.workerId ?? input.workerId);
      }
      throw err;
    }
    return {
      repoId: input.repoId,
      workerId: input.workerId,
      runId: input.runId,
      acquiredAt: input.now,
      heartbeatAt: input.now,
      expiresAt,
    };
  }

  heartbeat(repoId: RepositoryId, workerId: WorkerId, now: Date, newExpiresAt: Date): void {
    this.db
      .prepare(
        `UPDATE worker_leases
         SET heartbeat_at = @heartbeat_at, expires_at = @expires_at
         WHERE repo_id = @repo_id AND worker_id = @worker_id`,
      )
      .run({
        heartbeat_at: now.toISOString(),
        expires_at: newExpiresAt.toISOString(),
        repo_id: repoId,
        worker_id: workerId,
      });
  }

  release(repoId: RepositoryId, workerId: WorkerId): void {
    this.db
      .prepare(`DELETE FROM worker_leases WHERE repo_id = @repo_id AND worker_id = @worker_id`)
      .run({ repo_id: repoId, worker_id: workerId });
  }

  current(repoId: RepositoryId): WorkerLease | undefined {
    const row = this.db
      .prepare(`SELECT * FROM worker_leases WHERE repo_id = @repo_id`)
      .get({ repo_id: repoId }) as WorkerLeaseRow | undefined;
    return row ? toWorkerLease(row) : undefined;
  }

  reclaimExpired(input: ReclaimExpiredInput): WorkerLease[] {
    const expiredRows = this.db
      .prepare(`SELECT * FROM worker_leases WHERE expires_at < @now`)
      .all({ now: input.now.toISOString() }) as WorkerLeaseRow[];
    const reclaimed: WorkerLease[] = [];
    const errors: unknown[] = [];
    for (const row of expiredRows) {
      try {
        const lease = toWorkerLease(row);
        if (input.isWorkerAlive(lease.workerId)) continue;
        if (!input.recoverableRunIds.has(lease.runId)) continue;
        input.onReclaimed({
          repoId: lease.repoId,
          previousWorkerId: lease.workerId,
          previousRunId: lease.runId,
          reclaimedByWorkerId: input.reclaimedByWorkerId,
          reason: 'expired + worker stale + run recoverable',
        });
        input.resetWorktree(lease.repoId);
        this.db
          .prepare(`DELETE FROM worker_leases WHERE repo_id = @repo_id AND worker_id = @worker_id`)
          .run({ repo_id: lease.repoId, worker_id: lease.workerId });
        reclaimed.push(lease);
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'reclaimExpired: one or more errors during reclaim');
    }
    return reclaimed;
  }
}
