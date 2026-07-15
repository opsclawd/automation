import {
  type RepositoryId,
  type WorkerLease,
  type LeaseToken,
  WorkerLeaseConflictError,
  LeaseOwnershipLostError,
  RepositoryId as mkRepositoryId,
  WorkerId as mkWorkerId,
  RunId,
} from '@ai-sdlc/domain';
import type {
  WorkerLeasePort,
  AcquireLeaseInput,
  HeartbeatLeaseInput,
  ReleaseLeaseInput,
  ReclaimExpiredInput,
} from '@ai-sdlc/application/ports';
import type { Db } from './database.js';
import { randomBytes } from 'node:crypto';

interface WorkerLeaseRow {
  repo_id: string;
  worker_id: string;
  run_id: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
  lease_token: string;
}

function toWorkerLease(row: WorkerLeaseRow): WorkerLease {
  return {
    repoId: mkRepositoryId(row.repo_id),
    workerId: mkWorkerId(row.worker_id),
    runId: RunId(row.run_id),
    acquiredAt: new Date(row.acquired_at),
    heartbeatAt: new Date(row.heartbeat_at),
    expiresAt: new Date(row.expires_at),
    leaseToken: row.lease_token as LeaseToken,
  };
}

function makeLeaseToken(): LeaseToken {
  return randomBytes(16).toString('hex') as LeaseToken;
}

export class WorkerLeaseRepository implements WorkerLeasePort {
  constructor(private readonly db: Db) {}

  acquire(input: AcquireLeaseInput): WorkerLease {
    const expiresAt = new Date(input.now.getTime() + input.ttlMs);
    const nowIso = input.now.toISOString();
    const leaseToken = makeLeaseToken();

    const result = this.db
      .prepare(
        `INSERT INTO worker_leases (repo_id, worker_id, run_id, acquired_at, heartbeat_at, expires_at, lease_token)
         VALUES (@repo_id, @worker_id, @run_id, @acquired_at, @heartbeat_at, @expires_at, @lease_token)
         ON CONFLICT(repo_id) DO NOTHING`,
      )
      .run({
        repo_id: input.repoId,
        worker_id: input.workerId,
        run_id: input.runId,
        acquired_at: nowIso,
        heartbeat_at: nowIso,
        expires_at: expiresAt.toISOString(),
        lease_token: leaseToken,
      });
    if (result.changes === 0) {
      const existing = this.current(input.repoId);
      throw new WorkerLeaseConflictError(input.repoId, existing?.workerId ?? input.workerId);
    }
    return {
      repoId: input.repoId,
      workerId: input.workerId,
      runId: input.runId,
      acquiredAt: input.now,
      heartbeatAt: input.now,
      expiresAt,
      leaseToken,
    };
  }

  heartbeat(input: HeartbeatLeaseInput): void {
    const result = this.db
      .prepare(
        `UPDATE worker_leases
         SET heartbeat_at = @heartbeat_at, expires_at = @expires_at
         WHERE repo_id = @repo_id AND worker_id = @worker_id AND run_id = @run_id AND lease_token = @lease_token`,
      )
      .run({
        heartbeat_at: input.now.toISOString(),
        expires_at: input.newExpiresAt.toISOString(),
        repo_id: input.repoId,
        worker_id: input.workerId,
        run_id: input.runId,
        lease_token: input.leaseToken,
      });
    if (result.changes === 0) {
      throw new LeaseOwnershipLostError(input.repoId, input.leaseToken);
    }
  }

  release(input: ReleaseLeaseInput): void {
    const result = this.db
      .prepare(
        `DELETE FROM worker_leases WHERE repo_id = @repo_id AND worker_id = @worker_id AND run_id = @run_id AND lease_token = @lease_token`,
      )
      .run({
        repo_id: input.repoId,
        worker_id: input.workerId,
        run_id: input.runId,
        lease_token: input.leaseToken,
      });
    if (result.changes === 0) {
      throw new LeaseOwnershipLostError(input.repoId, input.leaseToken);
    }
  }

  current(repoId: RepositoryId): WorkerLease | undefined {
    const row = this.db
      .prepare(`SELECT * FROM worker_leases WHERE repo_id = @repo_id`)
      .get({ repo_id: repoId }) as WorkerLeaseRow | undefined;
    return row ? toWorkerLease(row) : undefined;
  }

  checkActiveLease(repoId: RepositoryId, now: Date): boolean {
    const row = this.db
      .prepare(`SELECT * FROM worker_leases WHERE repo_id = @repo_id`)
      .get({ repo_id: repoId }) as WorkerLeaseRow | undefined;
    return row !== undefined && new Date(row.expires_at).getTime() > now.getTime();
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
        input.resetWorktree(lease.repoId);
        input.onReclaimed({
          repoId: lease.repoId,
          previousWorkerId: lease.workerId,
          previousRunId: lease.runId,
          reclaimedByWorkerId: input.reclaimedByWorkerId,
          reason: 'expired + worker stale + run recoverable',
        });
        this.db
          .prepare(
            `DELETE FROM worker_leases WHERE repo_id = @repo_id AND worker_id = @worker_id AND run_id = @run_id AND lease_token = @lease_token`,
          )
          .run({
            repo_id: lease.repoId,
            worker_id: lease.workerId,
            run_id: lease.runId,
            lease_token: lease.leaseToken,
          });
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
