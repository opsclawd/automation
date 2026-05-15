import type { Phase, PhaseStatus } from '@ai-sdlc/domain';
import type { Db } from './database.js';

interface PhaseRow {
  id: string;
  run_uuid: string;
  name: string;
  status: string;
  attempt: number;
  started_at: string | null;
  completed_at: string | null;
}

export class PhaseRepository {
  constructor(private readonly db: Db) {}

  upsert(phase: Phase): void {
    this.db
      .prepare(
        `INSERT INTO phases (id, run_uuid, name, status, attempt, started_at, completed_at)
         VALUES (@id, @run_uuid, @name, @status, @attempt, @started_at, @completed_at)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           attempt = excluded.attempt,
           started_at = excluded.started_at,
           completed_at = excluded.completed_at`,
      )
      .run({
        id: phase.id,
        run_uuid: phase.runUuid,
        name: phase.name,
        status: phase.status,
        attempt: phase.attempt,
        started_at: phase.startedAt?.toISOString() ?? null,
        completed_at: phase.completedAt?.toISOString() ?? null,
      });
  }

  listByRun(runUuid: string): Phase[] {
    const rows = this.db
      .prepare('SELECT * FROM phases WHERE run_uuid = ? ORDER BY started_at ASC')
      .all(runUuid) as PhaseRow[];
    return rows.map((r) => ({
      id: r.id,
      runUuid: r.run_uuid,
      name: r.name,
      status: r.status as PhaseStatus,
      attempt: r.attempt,
      startedAt: r.started_at ? new Date(r.started_at) : undefined,
      completedAt: r.completed_at ? new Date(r.completed_at) : undefined,
    }));
  }
}
