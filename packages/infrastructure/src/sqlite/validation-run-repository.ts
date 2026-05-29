import type { Db } from './database.js';
import {
  RunId,
  PhaseName,
  type ValidationRun,
  type ValidationCommandRecord,
  type ValidationCommandOutcome,
  type ValidationCommandKind,
} from '@ai-sdlc/domain';
import type { ValidationRunRepositoryPort } from '@ai-sdlc/application/ports';

interface RunRow {
  id: string;
  run_uuid: string;
  phase_id: string;
  started_at: string;
  completed_at: string | null;
}

interface CmdRow {
  command: string;
  exit_code: number;
  duration_ms: number;
  stdout_path: string;
  stderr_path: string;
  outcome: string;
  kind: string | null;
  classifier: string | null;
}

function rowToCommand(r: CmdRow): ValidationCommandRecord {
  return {
    command: r.command,
    exitCode: r.exit_code,
    durationMs: r.duration_ms,
    stdoutPath: r.stdout_path,
    stderrPath: r.stderr_path,
    // Casts are unchecked: DB schema constrains these to valid enum values.
    // Matches pattern in agent-invocation-repository.ts:61.
    outcome: r.outcome as ValidationCommandOutcome,
    ...(r.kind !== null ? { kind: r.kind as ValidationCommandKind } : {}),
    ...(r.classifier !== null ? { classifier: r.classifier } : {}),
  };
}

export class ValidationRunRepository implements ValidationRunRepositoryPort {
  constructor(private readonly db: Db) {}

  save(run: ValidationRun): void {
    const tx = this.db.transaction((v: ValidationRun) => {
      const upsertRun = this.db.prepare(
        `INSERT INTO validation_runs (id, run_uuid, phase_id, started_at, completed_at)
         VALUES (@id, @runUuid, @phaseId, @startedAt, @completedAt)
         ON CONFLICT(id) DO UPDATE SET
           run_uuid = excluded.run_uuid,
           phase_id = excluded.phase_id,
           started_at = excluded.started_at,
           completed_at = excluded.completed_at`,
      );
      upsertRun.run({
        id: v.id,
        runUuid: v.runId,
        phaseId: v.phaseId,
        startedAt: v.startedAt.toISOString(),
        completedAt: v.completedAt?.toISOString() ?? null,
      });

      this.db
        .prepare(`DELETE FROM validation_command_results WHERE validation_run_id = ?`)
        .run(v.id);

      const insertCmd = this.db.prepare(
        `INSERT INTO validation_command_results
          (id, validation_run_id, ordinal, command, exit_code, duration_ms,
           stdout_path, stderr_path, outcome, kind, classifier)
         VALUES (@id, @validationRunId, @ordinal, @command, @exitCode, @durationMs,
           @stdoutPath, @stderrPath, @outcome, @kind, @classifier)`,
      );
      v.commands.forEach((c, ordinal) => {
        insertCmd.run({
          id: `${v.id}-${ordinal}`,
          validationRunId: v.id,
          ordinal,
          command: c.command,
          exitCode: c.exitCode,
          durationMs: c.durationMs,
          stdoutPath: c.stdoutPath,
          stderrPath: c.stderrPath,
          outcome: c.outcome,
          kind: c.kind ?? null,
          classifier: c.classifier ?? null,
        });
      });
    });
    tx(run);
  }

  findById(id: string): ValidationRun | null {
    const row = this.db.prepare(`SELECT * FROM validation_runs WHERE id = ?`).get(id) as
      | RunRow
      | undefined;
    if (!row) return null;
    return this.hydrate(row);
  }

  listByRun(runId: RunId): ValidationRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM validation_runs WHERE run_uuid = ? ORDER BY started_at ASC`)
      .all(runId) as RunRow[];
    return rows.map((r) => this.hydrate(r));
  }

  private hydrate(row: RunRow): ValidationRun {
    const cmds = this.db
      .prepare(
        `SELECT * FROM validation_command_results WHERE validation_run_id = ? ORDER BY ordinal ASC`,
      )
      .all(row.id) as CmdRow[];
    return {
      id: row.id,
      runId: RunId(row.run_uuid),
      phaseId: PhaseName(row.phase_id),
      startedAt: new Date(row.started_at),
      ...(row.completed_at !== null ? { completedAt: new Date(row.completed_at) } : {}),
      commands: cmds.map(rowToCommand),
    };
  }
}
