import { RepositoryId } from '@ai-sdlc/domain';
import type { Run, RunStatus } from '@ai-sdlc/domain';
import type { RunRepositoryUpdatePatch } from '@ai-sdlc/application/ports';
import type { Db } from './database.js';

interface RunRow {
  uuid: string;
  display_id: string;
  repo_id: string | null;
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
  base_branch: string | null;
  model_override: string | null;
  runtime_override: string | null;
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
  pid?: number | undefined;
  startCommitSha?: string | undefined;
  baseBranch?: string | undefined;
  modelOverride?: string | undefined;
  runtimeOverride?: string | undefined;
}

/** Implements RunRepositoryPort (@ai-sdlc/application). */
export class RunRepository {
  constructor(private readonly db: Db) {}

  insert(run: Run, pid?: number): void {
    this.db
      .prepare(
        `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, current_phase,
        completed_phases, skipped_phases, started_at, completed_at, failure_reason, pid, start_commit_sha, base_branch, model_override, runtime_override)
         VALUES (@uuid, @display_id, @repo_id, @issue_number, @type, @status, @current_phase,
           @completed_phases, @skipped_phases, @started_at, @completed_at, @failure_reason, @pid, @start_commit_sha, @base_branch, @model_override, @runtime_override)`,
      )
      .run({
        uuid: run.uuid,
        display_id: run.displayId,
        repo_id: run.repoId,
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
        base_branch: run.baseBranch ?? null,
        model_override: run.modelOverride ?? null,
        runtime_override: run.runtimeOverride ?? null,
      });
  }

  insertIfNoActive(run: Run): void {
    const tx = this.db.transaction((r: Run) => {
      // Also block on legacy rows backfilled with 'unknown' — we can't know
      // their real repo so treat them as conflicting with any new run on the
      // same issue number until they reach a terminal state.
      const active = this.db
        .prepare(
          `SELECT 1 FROM runs WHERE (repo_id = ? OR repo_id = 'unknown') AND issue_number = ? AND status NOT IN ('passed','failed','cancelled')`,
        )
        .get(r.repoId, r.issueNumber);
      if (active) {
        throw new Error(
          `An active run already exists for repository ${r.repoId} issue ${r.issueNumber}`,
        );
      }
      this.insert(r, process.pid);
    });
    tx(run);
  }

  atomicUpdateByUuid(
    uuid: string,
    patch: RunRepositoryUpdatePatch,
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
      params.completed_at = patch.completedAt?.toISOString() ?? null;
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
    if (patch.startCommitSha !== undefined) {
      fields.push('start_commit_sha = @start_commit_sha');
      params.start_commit_sha = patch.startCommitSha;
    }
    if (patch.baseBranch !== undefined) {
      fields.push("base_branch = @base_branch");
      params.base_branch = patch.baseBranch;
    }
    if (patch.modelOverride !== undefined) {
      fields.push("model_override = @model_override");
      params.model_override = patch.modelOverride;
    }
    if (patch.runtimeOverride !== undefined) {
      fields.push("runtime_override = @runtime_override");
      params.runtime_override = patch.runtimeOverride;
    }
    if (patch.pid !== undefined) {
      fields.push('pid = @pid');
      params.pid = patch.pid;
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

  update(uuid: string, patch: RunRepositoryUpdatePatch): void {
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
      params.completed_at = patch.completedAt?.toISOString() ?? null;
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
    if (patch.startCommitSha !== undefined) {
      fields.push('start_commit_sha = @start_commit_sha');
      params.start_commit_sha = patch.startCommitSha;
    }
    if (patch.baseBranch !== undefined) {
      fields.push("base_branch = @base_branch");
      params.base_branch = patch.baseBranch;
    }
    if (patch.modelOverride !== undefined) {
      fields.push("model_override = @model_override");
      params.model_override = patch.modelOverride;
    }
    if (patch.runtimeOverride !== undefined) {
      fields.push("runtime_override = @runtime_override");
      params.runtime_override = patch.runtimeOverride;
    }
    if (patch.pid !== undefined) {
      fields.push('pid = @pid');
      params.pid = patch.pid;
    }
    if (fields.length === 0) return;
    this.db.prepare(`UPDATE runs SET ${fields.join(', ')} WHERE uuid = @uuid`).run(params);
  }

  findByIssueNumber(repoId: RepositoryId | number, issueNumber?: number): RunRecord | undefined {
    if (typeof repoId === 'number') {
      const row = this.db
        .prepare('SELECT * FROM runs WHERE issue_number = ? ORDER BY started_at DESC LIMIT 1')
        .get(repoId) as RunRow | undefined;
      return row ? toRecord(row) : undefined;
    }
    const row = this.db
      .prepare(
        'SELECT * FROM runs WHERE repo_id = ? AND issue_number = ? ORDER BY started_at DESC LIMIT 1',
      )
      .get(repoId, issueNumber) as RunRow | undefined;
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
  ): boolean;
  updateStatusByIssueNumber(
    repoId: RepositoryId,
    issueNumber: number,
    patch: { status: RunStatus; completedAt: Date; failureReason?: string },
  ): boolean;
  updateStatusByIssueNumber(
    repoIdOrIssueNumber: RepositoryId | number,
    issueNumberOrPatch?: number | { status: RunStatus; completedAt: Date; failureReason?: string },
    maybePatch?: { status: RunStatus; completedAt: Date; failureReason?: string },
  ): boolean {
    if (typeof repoIdOrIssueNumber === 'number') {
      const actualIssueNumber = repoIdOrIssueNumber;
      const actualPatch = issueNumberOrPatch as
        | {
            status: RunStatus;
            completedAt: Date;
            failureReason?: string;
          }
        | undefined;
      if (!actualPatch) {
        throw new Error('Missing patch argument for updateStatusByIssueNumber');
      }
      const result = this.db
        .prepare(
          `UPDATE runs SET status = @status, completed_at = @completed_at, failure_reason = @failure_reason
           WHERE issue_number = @issue_number AND status NOT IN ('passed','failed','cancelled')`,
        )
        .run({
          status: actualPatch.status,
          completed_at: actualPatch.completedAt.toISOString(),
          failure_reason: actualPatch.failureReason ?? null,
          issue_number: actualIssueNumber,
        });
      return result.changes > 0;
    }

    if (typeof issueNumberOrPatch !== 'number') {
      throw new Error('Invalid or missing issueNumber argument for updateStatusByIssueNumber');
    }
    if (!maybePatch) {
      throw new Error('Missing patch argument for updateStatusByIssueNumber');
    }

    const result = this.db
      .prepare(
        `UPDATE runs SET status = @status, completed_at = @completed_at, failure_reason = @failure_reason
         WHERE repo_id = @repo_id AND issue_number = @issue_number AND status NOT IN ('passed','failed','cancelled')`,
      )
      .run({
        status: maybePatch.status,
        completed_at: maybePatch.completedAt.toISOString(),
        failure_reason: maybePatch.failureReason ?? null,
        repo_id: repoIdOrIssueNumber,
        issue_number: issueNumberOrPatch,
      });
    return result.changes > 0;
  }

  updateStatusByUuid(
    uuid: string,
    patch: {
      status: RunStatus;
      completedAt: Date;
      failureReason?: string;
      currentPhase?: string | null;
    },
  ): boolean {
    const fields: string[] = ['status = @status', 'completed_at = @completed_at'];
    const params: Record<string, unknown> = {
      status: patch.status,
      completed_at: patch.completedAt.toISOString(),
      uuid,
    };
    if (patch.failureReason !== undefined) {
      fields.push('failure_reason = @failure_reason');
      params.failure_reason = patch.failureReason;
    }
    if (patch.currentPhase !== undefined) {
      fields.push('current_phase = @current_phase');
      params.current_phase = patch.currentPhase;
    }
    const sql = `UPDATE runs SET ${fields.join(', ')} WHERE uuid = @uuid AND status NOT IN ('passed','failed','cancelled')`;
    const result = this.db.prepare(sql).run(params);
    return result.changes > 0;
  }
}

function toRecord(row: RunRow): RunRecord {
  return {
    uuid: row.uuid,
    displayId: row.display_id,
    repoId: RepositoryId(row.repo_id ?? 'unknown'),
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
    ...(row.base_branch !== null ? { baseBranch: row.base_branch } : {}),
    ...(row.model_override !== null ? { modelOverride: row.model_override } : {}),
    ...(row.runtime_override !== null ? { runtimeOverride: row.runtime_override } : {}),
  };
}
