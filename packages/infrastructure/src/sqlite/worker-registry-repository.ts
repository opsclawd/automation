import {
  type Worker,
  type WorkerId,
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

function toWorker(row: WorkerRow): Worker {
  return {
    id: mkWorkerId(row.id),
    hostname: row.hostname,
    processId: row.process_id,
    status: row.status as Worker['status'],
    heartbeatAt: new Date(row.heartbeat_at),
  };
}

export class WorkerRegistryRepository implements WorkerRegistryPort {
  constructor(private readonly db: Db) {}

  register(w: Worker): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO workers (id, hostname, process_id, status, heartbeat_at)
         VALUES (@id, @hostname, @process_id, @status, @heartbeat_at)`,
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
