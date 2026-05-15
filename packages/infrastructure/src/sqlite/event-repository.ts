import type { Db } from './database.js';

export interface EventRow {
  id: number;
  runUuid: string;
  phase?: string | undefined;
  level: string;
  type: string;
  message: string;
  metadata: Record<string, unknown>;
  timestamp: Date;
}

export interface EventInput {
  runUuid: string;
  phase?: string;
  level: string;
  type: string;
  message: string;
  metadata?: Record<string, unknown>;
  timestamp: Date;
}

export class EventRepository {
  constructor(private readonly db: Db) {}

  insert(event: EventInput): number {
    const res = this.db
      .prepare(
        `INSERT INTO events (run_uuid, phase, level, type, message, metadata, timestamp)
         VALUES (@run_uuid, @phase, @level, @type, @message, @metadata, @timestamp)`,
      )
      .run({
        run_uuid: event.runUuid,
        phase: event.phase ?? null,
        level: event.level,
        type: event.type,
        message: event.message,
        metadata: JSON.stringify(event.metadata ?? {}),
        timestamp: event.timestamp.toISOString(),
      });
    return Number(res.lastInsertRowid);
  }

  listByRunSince(runUuid: string, sinceIso?: string): EventRow[] {
    let sql = 'SELECT * FROM events WHERE run_uuid = ?';
    const params: unknown[] = [runUuid];
    if (sinceIso !== undefined) {
      sql += ' AND timestamp > ?';
      params.push(sinceIso);
    }
    sql += ' ORDER BY timestamp ASC';
    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: number;
      run_uuid: string;
      phase: string | null;
      level: string;
      type: string;
      message: string;
      metadata: string;
      timestamp: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      runUuid: r.run_uuid,
      ...(r.phase !== null ? { phase: r.phase } : {}),
      level: r.level,
      type: r.type,
      message: r.message,
      metadata: JSON.parse(r.metadata) as Record<string, unknown>,
      timestamp: new Date(r.timestamp),
    }));
  }
}
