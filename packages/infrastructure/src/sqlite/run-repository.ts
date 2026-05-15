import type { Run, RunStatus } from '@ai-sdlc/domain';
import type { Db } from './database.js';

interface RunRow {
  uuid: string;
  display_id: string;
  issue_number: number;
  type: string;
  status: string;
  current_phase: string | null;
  completed_phases: string;
  started_at: string;
  completed_at: string | null;
  failure_reason: string | null;
  exit_code: number | null;
  duration_ms: number | null;
}

export interface RunRecord extends Run {
  exitCode?: number;
  durationMs?: number;
}

export class RunRepository {
  constructor(private readonly db: Db) {}

  insert(run: Run): void {
    this.db
      .prepare(
        `INSERT INTO runs (uuid, display_id, issue_number, type, status, current_phase,
          completed_phases, started_at, completed_at, failure_reason)
         VALUES (@uuid, @display_id, @issue_number, @type, @status, @current_phase,
          @completed_phases, @started_at, @completed_at, @failure_reason)`,
      )
      .run({
        uuid: run.uuid,
        display_id: run.displayId,
        issue_number: run.issueNumber,
        type: run.type,
        status: run.status,
        current_phase: run.currentPhase ?? null,
        completed_phases: JSON.stringify(run.completedPhases),
        started_at: run.startedAt.toISOString(),
        completed_at: run.completedAt?.toISOString() ?? null,
        failure_reason: run.failureReason ?? null,
      });
  }

  insertIfNoActive(run: Run): void {
    const tx = this.db.transaction((r: Run) => {
      const active = this.db
        .prepare(
          `SELECT 1 FROM runs WHERE issue_number = ? AND status NOT IN ('passed','failed','cancelled')`,
        )
        .get(r.issueNumber);
      if (active) {
        throw new Error(`An active run already exists for issue ${r.issueNumber}`);
      }
      this.insert(r);
    });
    tx(run);
  }

  findByUuid(uuid: string): RunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE uuid = ?').get(uuid) as
      | RunRow
      | undefined;
    return row ? toRecord(row) : undefined;
  }

  list(): RunRecord[] {
    const rows = this.db.prepare('SELECT * FROM runs ORDER BY started_at DESC').all() as RunRow[];
    return rows.map(toRecord);
  }

  update(
    uuid: string,
    patch: Partial<{
      status: RunStatus;
      currentPhase: string | null;
      completedPhases: string[];
      completedAt: Date;
      failureReason: string;
      exitCode: number;
      durationMs: number;
    }>,
  ): void {
    const fields: string[] = [];
    const params: Record<string, unknown> = { uuid };
    if (patch.status !== undefined) {
      fields.push('status = @status');
      params.status = patch.status;
    }
    if (patch.currentPhase !== undefined) {
      fields.push('current_phase = @current_phase');
      params.current_phase = patch.currentPhase;
    }
    if (patch.completedPhases !== undefined) {
      fields.push('completed_phases = @completed_phases');
      params.completed_phases = JSON.stringify(patch.completedPhases);
    }
    if (patch.completedAt !== undefined) {
      fields.push('completed_at = @completed_at');
      params.completed_at = patch.completedAt.toISOString();
    }
    if (patch.failureReason !== undefined) {
      fields.push('failure_reason = @failure_reason');
      params.failure_reason = patch.failureReason;
    }
    if (patch.exitCode !== undefined) {
      fields.push('exit_code = @exit_code');
      params.exit_code = patch.exitCode;
    }
    if (patch.durationMs !== undefined) {
      fields.push('duration_ms = @duration_ms');
      params.duration_ms = patch.durationMs;
    }
    if (fields.length === 0) return;
    this.db.prepare(`UPDATE runs SET ${fields.join(', ')} WHERE uuid = @uuid`).run(params);
  }
}

function toRecord(row: RunRow): RunRecord {
  return {
    uuid: row.uuid,
    displayId: row.display_id,
    issueNumber: row.issue_number,
    type: row.type as Run['type'],
    status: row.status as RunStatus,
    completedPhases: JSON.parse(row.completed_phases) as string[],
    startedAt: new Date(row.started_at),
    ...(row.current_phase !== null ? { currentPhase: row.current_phase } : {}),
    ...(row.completed_at !== null ? { completedAt: new Date(row.completed_at) } : {}),
    ...(row.failure_reason !== null ? { failureReason: row.failure_reason } : {}),
    ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
  };
}
