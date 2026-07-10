import {
  type Worker,
  type WorkerId,
  type WorkerStatus,
  WorkerId as mkWorkerId,
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
        `INSERT INTO workers (id, hostname, process_id, status, heartbeat_at)
         VALUES (@id, @hostname, @process_id, @status, @heartbeat_at)
         ON CONFLICT(id) DO UPDATE SET
           hostname = excluded.hostname,
           process_id = excluded.process_id,
           status = excluded.status,
           heartbeat_at = excluded.heartbeat_at`,
      )
      .run({
        id: w.id,
        hostname: w.hostname,
        process_id: w.processId,
        status: w.status,
        heartbeat_at: w.heartbeatAt.toISOString(),
      });
  }

  heartbeat(id: WorkerId, now: Date): void {
    const w = this.requireWorker(id);
    const updated = heartbeatWorker(w, now);
    this.db
      .prepare(`UPDATE workers SET heartbeat_at = @heartbeat_at WHERE id = @id`)
      .run({ heartbeat_at: updated.heartbeatAt.toISOString(), id });
  }

  markBusy(id: WorkerId): void {
    this.updateStatus(id, markWorkerBusy);
  }
  markIdle(id: WorkerId): void {
    this.updateStatus(id, markWorkerIdle);
  }
  markStopping(id: WorkerId): void {
    this.updateStatus(id, markWorkerStopping);
  }
  markUnhealthy(id: WorkerId): void {
    this.updateStatus(id, markWorkerUnhealthy);
  }

  list(): Worker[] {
    const rows = this.db.prepare('SELECT * FROM workers').all() as WorkerRow[];
    return rows.map(toWorker);
  }

  findById(id: WorkerId): Worker | undefined {
    const row = this.db.prepare('SELECT * FROM workers WHERE id = ?').get(id) as
      | WorkerRow
      | undefined;
    return row ? toWorker(row) : undefined;
  }

  deregister(id: WorkerId): void {
    this.db.prepare('DELETE FROM workers WHERE id = ?').run(id);
  }

  private requireWorker(id: WorkerId): Worker {
    const row = this.db.prepare('SELECT * FROM workers WHERE id = ?').get(id) as
      | WorkerRow
      | undefined;
    if (!row) throw new Error(`unknown worker ${id}`);
    return toWorker(row);
  }

  private updateStatus(id: WorkerId, fn: (w: Worker) => Worker): void {
    const updated = fn(this.requireWorker(id));
    this.db
      .prepare('UPDATE workers SET status = @status WHERE id = @id')
      .run({ status: updated.status, id });
  }
}
