import {
  type RepositoryId,
  type Worker,
  type WorkerId,
  type WorkerStatus,
  WorkerId as mkWorkerId,
  RepositoryId as mkRepositoryId,
  markWorkerBusy,
  markWorkerIdle,
  markWorkerStopping,
  markWorkerUnhealthy,
  heartbeatWorker,
} from '@ai-sdlc/domain';
import type { WorkerRegistryPort } from '@ai-sdlc/application/ports';
import type { Db } from './database.js';

interface WorkerRow {
  id: string;
  repo_id: string;
  hostname: string;
  process_id: number;
  status: string;
  heartbeat_at: string;
}

const WORKER_STATUS_VALUES: readonly WorkerStatus[] = ['idle', 'busy', 'stopping', 'unhealthy'];

class WorkerStatusError extends Error {
  constructor(value: string) {
    super(`unknown worker status '${value}'`);
    this.name = 'WorkerStatusError';
  }
}

function toWorkerStatus(value: string): WorkerStatus {
  if ((WORKER_STATUS_VALUES as readonly string[]).includes(value)) {
    return value as WorkerStatus;
  }
  throw new WorkerStatusError(value);
}

function toWorker(row: WorkerRow): Worker {
  return {
    id: mkWorkerId(row.id),
    repoId: mkRepositoryId(row.repo_id),
    hostname: row.hostname,
    processId: row.process_id,
    status: toWorkerStatus(row.status),
    heartbeatAt: new Date(row.heartbeat_at),
  };
}

export class WorkerRegistryRepository implements WorkerRegistryPort {
  constructor(private readonly db: Db) {}

  register(w: Worker): void {
    this.db
      .prepare(
        `INSERT INTO workers (id, repo_id, hostname, process_id, status, heartbeat_at)
         VALUES (@id, @repo_id, @hostname, @process_id, @status, @heartbeat_at)
         ON CONFLICT(id) DO UPDATE SET
           repo_id = excluded.repo_id,
           hostname = excluded.hostname,
           process_id = excluded.process_id,
           status = excluded.status,
           heartbeat_at = excluded.heartbeat_at`,
      )
      .run({
        id: w.id,
        repo_id: w.repoId,
        hostname: w.hostname,
        process_id: w.processId,
        status: w.status,
        heartbeat_at: w.heartbeatAt.toISOString(),
      });
  }

  heartbeat(id: WorkerId, repoId: RepositoryId, now: Date): void {
    const w = this.requireWorker(id, repoId);
    const updated = heartbeatWorker(w, now);
    this.db
      .prepare(
        `UPDATE workers SET heartbeat_at = @heartbeat_at WHERE id = @id AND repo_id = @repo_id`,
      )
      .run({ heartbeat_at: updated.heartbeatAt.toISOString(), id, repo_id: repoId });
  }

  markBusy(id: WorkerId, repoId: RepositoryId): void {
    this.updateStatus(id, repoId, markWorkerBusy);
  }
  markIdle(id: WorkerId, repoId: RepositoryId): void {
    this.updateStatus(id, repoId, markWorkerIdle);
  }
  markStopping(id: WorkerId, repoId: RepositoryId): void {
    this.updateStatus(id, repoId, markWorkerStopping);
  }
  markUnhealthy(id: WorkerId, repoId: RepositoryId): void {
    this.updateStatus(id, repoId, markWorkerUnhealthy);
  }

  list(): Worker[] {
    const rows = this.db.prepare('SELECT * FROM workers').all() as WorkerRow[];
    return rows.map(toWorker);
  }

  findById(id: WorkerId, repoId: RepositoryId): Worker | undefined {
    const row = this.db
      .prepare('SELECT * FROM workers WHERE id = ? AND repo_id = ?')
      .get(id, repoId) as WorkerRow | undefined;
    return row ? toWorker(row) : undefined;
  }

  deregister(id: WorkerId): void {
    this.db.prepare('DELETE FROM workers WHERE id = ?').run(id);
  }

  private requireWorker(id: WorkerId, repoId: RepositoryId): Worker {
    const row = this.db
      .prepare('SELECT * FROM workers WHERE id = ? AND repo_id = ?')
      .get(id, repoId) as WorkerRow | undefined;
    if (!row) throw new Error(`unknown worker ${id}`);
    return toWorker(row);
  }

  private updateStatus(id: WorkerId, repoId: RepositoryId, fn: (w: Worker) => Worker): void {
    const updated = fn(this.requireWorker(id, repoId));
    this.db
      .prepare('UPDATE workers SET status = @status WHERE id = @id AND repo_id = @repo_id')
      .run({ status: updated.status, id, repo_id: repoId });
  }
}
