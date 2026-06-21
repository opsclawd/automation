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
      if (
        err instanceof Error &&
        'code' in err &&
        (err as { code: string }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
      ) {
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
    const row = this.db.prepare(`SELECT * FROM worker_leases WHERE repo_id = ?`).get(repoId) as
      | WorkerLeaseRow
      | undefined;
    return row ? toWorkerLease(row) : undefined;
  }

  reclaimExpired(input: ReclaimExpiredInput): WorkerLease[] {
    const expiredRows = this.db
      .prepare(`SELECT * FROM worker_leases WHERE expires_at < ?`)
      .all(input.now.toISOString()) as WorkerLeaseRow[];
    const reclaimed: WorkerLease[] = [];
    for (const row of expiredRows) {
      const lease = toWorkerLease(row);
      if (input.isWorkerAlive(lease.workerId)) continue;
      if (!input.recoverableRunIds.has(lease.runId)) continue;
      input.resetWorktree(lease.repoId);
      input.onReclaimed({
        repoId: lease.repoId,
        previousWorkerId: lease.workerId,
        previousRunId: lease.runId,
        reclaimedByWorkerId: input.reclaimedByWorkerId,
        reason: 'expired + worker stale + run recoverable',
      });
      this.db.prepare(`DELETE FROM worker_leases WHERE repo_id = ?`).run(lease.repoId);
      reclaimed.push(lease);
    }
    return reclaimed;
  }
}
