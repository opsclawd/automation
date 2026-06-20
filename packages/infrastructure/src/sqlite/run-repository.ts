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
  skipped_phases: string;
  started_at: string;
  completed_at: string | null;
  failure_reason: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  pid: number | null;
  start_commit_sha: string | null;
}

/**
 * RunRecord extends the domain Run with infrastructure-level fields
 * (exitCode, durationMs, pid) for persistence and querying.
 *
 * NOTE: A matching RunRecord type is defined in @ai-sdlc/application
 * (ports.ts). Both definitions must stay in sync manually. This
 * duplication is required because application MUST NOT import
 * infrastructure per AGENTS.md layer boundary rules.
 */
export interface RunRecord extends Run {
  exitCode?: number;
  durationMs?: number;
  pid?: number;
  startCommitSha?: string;
}

/** Implements RunRepositoryPort (@ai-sdlc/application). */
export class RunRepository {
  constructor(private readonly db: Db) {}

  insert(run: Run, pid?: number): void {
    this.db
      .prepare(
        `INSERT INTO runs (uuid, display_id, issue_number, type, status, current_phase,
        completed_phases, skipped_phases, started_at, completed_at, failure_reason, pid, start_commit_sha)
         VALUES (@uuid, @display_id, @issue_number, @type, @status, @current_phase,
           @completed_phases, @skipped_phases, @started_at, @completed_at, @failure_reason, @pid, @start_commit_sha)`,
      )
      .run({
        uuid: run.uuid,
        display_id: run.displayId,
        issue_number: run.issueNumber,
        type: run.type,
        status: run.status,
        current_phase: run.currentPhase ?? null,
        completed_phases: JSON.stringify(run.completedPhases),
        skipped_phases: JSON.stringify(run.skippedPhases ?? []),
        started_at: run.startedAt.toISOString(),
        completed_at: run.completedAt?.toISOString() ?? null,
        failure_reason: run.failureReason ?? null,
        pid: pid ?? null,
        start_commit_sha: (run as RunRecord).startCommitSha ?? null,
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
      this.insert(r, process.pid);
    });
    tx(run);
  }

  atomicUpdateByUuid(
    uuid: string,
    patch: Partial<{
      status: RunStatus;
      currentPhase: string | null;
      completedPhases: string[];
      skippedPhases: string[];
      completedAt: Date;
      failureReason: string;
      exitCode: number;
      durationMs: number;
    }>,
    expectedStatus: RunStatus,
  ): boolean {
    const fields: string[] = [];
    const params: Record<string, unknown> = { uuid, expected_status: expectedStatus };
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
    if (patch.skippedPhases !== undefined) {
      fields.push('skipped_phases = @skipped_phases');
      params.skipped_phases = JSON.stringify(patch.skippedPhases);
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
    if (fields.length === 0) return false;
    const result = this.db
      .prepare(
        `UPDATE runs SET ${fields.join(', ')} WHERE uuid = @uuid AND status = @expected_status`,
      )
      .run(params);
    return result.changes > 0;
  }

  findByUuid(uuid: string): RunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE uuid = ?').get(uuid) as
      | RunRow
      | undefined;
    return row ? toRecord(row) : undefined;
  }

  list(opts?: { limit: number; offset?: number }): { runs: RunRecord[]; total: number } {
    const totalRow = this.db.prepare('SELECT COUNT(*) AS total FROM runs').get() as {
      total: number;
    };
    const total = totalRow.total;

    if (opts?.limit === undefined) {
      const rows = this.db.prepare('SELECT * FROM runs ORDER BY started_at DESC').all() as RunRow[];
      return { runs: rows.map(toRecord), total };
    }

    const limit = Math.max(1, Math.min(opts.limit, 100));
    const offset = Math.max(0, opts.offset ?? 0);
    const rows = this.db
      .prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as RunRow[];
    return { runs: rows.map(toRecord), total };
  }

  update(
    uuid: string,
    patch: Partial<{
      status: RunStatus;
      currentPhase: string | null;
      completedPhases: string[];
      skippedPhases: string[];
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
    if (patch.skippedPhases !== undefined) {
      fields.push('skipped_phases = @skipped_phases');
      params.skipped_phases = JSON.stringify(patch.skippedPhases);
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

  findByIssueNumber(issueNumber: number): RunRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM runs WHERE issue_number = ? ORDER BY started_at DESC LIMIT 1')
      .get(issueNumber) as RunRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  findActiveRuns(): RunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM runs WHERE status NOT IN ('passed','failed','cancelled') ORDER BY started_at`,
      )
      .all() as RunRow[];
    return rows.map(toRecord);
  }

  updateStatusByIssueNumber(
    issueNumber: number,
    patch: { status: RunStatus; completedAt: Date; failureReason?: string },
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE runs SET status = @status, completed_at = @completed_at, failure_reason = @failure_reason
         WHERE issue_number = @issue_number AND status NOT IN ('passed','failed','cancelled')`,
      )
      .run({
        status: patch.status,
        completed_at: patch.completedAt.toISOString(),
        failure_reason: patch.failureReason ?? null,
        issue_number: issueNumber,
      });
    return result.changes > 0;
  }

  updateStatusByUuid(
    uuid: string,
    patch: { status: RunStatus; completedAt: Date; failureReason?: string },
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE runs SET status = @status, completed_at = @completed_at,
           failure_reason = @failure_reason, current_phase = NULL
         WHERE uuid = @uuid AND status NOT IN ('passed','failed','cancelled')`,
      )
      .run({
        status: patch.status,
        completed_at: patch.completedAt.toISOString(),
        failure_reason: patch.failureReason ?? null,
        uuid,
      });
    return result.changes > 0;
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
    skippedPhases: JSON.parse(row.skipped_phases) as string[],
    startedAt: new Date(row.started_at),
    ...(row.current_phase !== null ? { currentPhase: row.current_phase } : {}),
    ...(row.completed_at !== null ? { completedAt: new Date(row.completed_at) } : {}),
    ...(row.failure_reason !== null ? { failureReason: row.failure_reason } : {}),
    ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    ...(row.pid !== null ? { pid: row.pid } : {}),
    ...(row.start_commit_sha !== null ? { startCommitSha: row.start_commit_sha } : {}),
  };
}
