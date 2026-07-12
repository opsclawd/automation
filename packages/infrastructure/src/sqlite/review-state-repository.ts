import type { Db } from './database.js';
import type {
  ReviewAttempt,
  ReviewDimensionState,
  ReviewSnapshot,
  ReviewFindingRecord,
  DispositionHistoryEntry,
  ReviewStateRepositoryPort,
} from '@ai-sdlc/application/ports';

interface AttemptRow {
  id: string;
  run_uuid: string;
  scope: string;
  step: string;
  review_mode: string;
  dimension: string;
  snapshot_kind: string | null;
  snapshot_identity: string | null;
  snapshot_base_identity: string | null;
  snapshot_captured_at: string | null;
  verdict: string | null;
  created_at: string;
  artifacts_json: string;
}

interface DimensionStateRow {
  id: string;
  run_uuid: string;
  scope: string;
  step: string;
  dimension: string;
  latest_snapshot_kind: string | null;
  latest_snapshot_identity: string | null;
  latest_snapshot_base_identity: string | null;
  latest_snapshot_captured_at: string | null;
  latest_verdict: string | null;
  dirty: number;
  provisionally_clean: number;
  unresolved_records_json: string;
  disposition_history_json: string;
  updated_at: string;
}

function rowToSnapshot(
  kind: string | null,
  identity: string | null,
  baseIdentity: string | null,
  capturedAt: string | null,
): ReviewSnapshot | undefined {
  if (!kind || !identity || !capturedAt) return undefined;
  return {
    kind: kind as ReviewSnapshot['kind'],
    identity,
    ...(baseIdentity ? { baseIdentity } : {}),
    capturedAt,
  };
}

function rowToAttempt(r: AttemptRow): ReviewAttempt {
  const snapshot = rowToSnapshot(
    r.snapshot_kind,
    r.snapshot_identity,
    r.snapshot_base_identity,
    r.snapshot_captured_at,
  );
  const result: ReviewAttempt = {
    attemptId: r.id,
    runId: r.run_uuid,
    scope: r.scope,
    step: r.step,
    reviewMode: r.review_mode as ReviewAttempt['reviewMode'],
    dimension: r.dimension,
    createdAt: r.created_at,
    artifacts: JSON.parse(r.artifacts_json),
  };
  if (snapshot) result.snapshot = snapshot;
  if (r.verdict) result.verdict = r.verdict;
  return result;
}

function rowToDimensionState(r: DimensionStateRow): ReviewDimensionState {
  const unresolvedRecords: ReviewFindingRecord[] = JSON.parse(r.unresolved_records_json);
  const dispositionHistory: DispositionHistoryEntry[] = JSON.parse(r.disposition_history_json);
  const latestSnapshot = rowToSnapshot(
    r.latest_snapshot_kind,
    r.latest_snapshot_identity,
    r.latest_snapshot_base_identity,
    r.latest_snapshot_captured_at,
  );
  const result: ReviewDimensionState = {
    dimension: r.dimension,
    dirty: r.dirty === 1,
    provisionallyClean: r.provisionally_clean === 1,
    unresolvedRecords,
    dispositionHistory,
  };
  if (latestSnapshot) result.latestSnapshot = latestSnapshot;
  if (r.latest_verdict) result.latestVerdict = r.latest_verdict;
  return result;
}

export class ReviewStateRepository implements ReviewStateRepositoryPort {
  constructor(private readonly db: Db) {}

  appendAttempt(attempt: ReviewAttempt): void {
    this.db
      .prepare(
        `INSERT INTO review_attempts
           (id, run_uuid, scope, step, review_mode, dimension,
            snapshot_kind, snapshot_identity, snapshot_base_identity, snapshot_captured_at,
            verdict, created_at, artifacts_json)
         VALUES (@id, @run_uuid, @scope, @step, @review_mode, @dimension,
                 @snapshot_kind, @snapshot_identity, @snapshot_base_identity, @snapshot_captured_at,
                 @verdict, @created_at, @artifacts_json)`,
      )
      .run({
        id: attempt.attemptId,
        run_uuid: attempt.runId,
        scope: attempt.scope,
        step: attempt.step,
        review_mode: attempt.reviewMode,
        dimension: attempt.dimension,
        snapshot_kind: attempt.snapshot?.kind ?? null,
        snapshot_identity: attempt.snapshot?.identity ?? null,
        snapshot_base_identity: attempt.snapshot?.baseIdentity ?? null,
        snapshot_captured_at: attempt.snapshot?.capturedAt ?? null,
        verdict: attempt.verdict ?? null,
        created_at: attempt.createdAt,
        artifacts_json: JSON.stringify(attempt.artifacts),
      });
  }

  listAttempts(runId: string, scope: string, step: string, dimension?: string): ReviewAttempt[] {
    const baseQuery = `SELECT * FROM review_attempts
         WHERE run_uuid = ? AND scope = ? AND step = ?`;
    const query = dimension
      ? `${baseQuery} AND dimension = ? ORDER BY created_at ASC`
      : `${baseQuery} ORDER BY created_at ASC`;
    const params = dimension ? [runId, scope, step, dimension] : [runId, scope, step];
    const rows = this.db.prepare(query).all(...params) as AttemptRow[];
    return rows.map(rowToAttempt);
  }

  upsertDimensionState(
    runId: string,
    scope: string,
    step: string,
    state: ReviewDimensionState,
  ): void {
    const id = `${runId}|${scope}|${step}|${state.dimension}`;
    const latestSnapshot = state.latestSnapshot;
    const unresolvedRecordsJson = JSON.stringify(state.unresolvedRecords);
    const dispositionHistoryJson = JSON.stringify(state.dispositionHistory);

    this.db
      .prepare(
        `INSERT INTO review_dimension_states
           (id, run_uuid, scope, step, dimension,
            latest_snapshot_kind, latest_snapshot_identity, latest_snapshot_base_identity,
            latest_snapshot_captured_at, latest_verdict, dirty, provisionally_clean,
            unresolved_records_json, disposition_history_json, updated_at)
         VALUES (@id, @run_uuid, @scope, @step, @dimension,
                 @latest_snapshot_kind, @latest_snapshot_identity, @latest_snapshot_base_identity,
                 @latest_snapshot_captured_at, @latest_verdict, @dirty, @provisionally_clean,
                 @unresolved_records_json, @disposition_history_json, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           latest_snapshot_kind = excluded.latest_snapshot_kind,
           latest_snapshot_identity = excluded.latest_snapshot_identity,
           latest_snapshot_base_identity = excluded.latest_snapshot_base_identity,
           latest_snapshot_captured_at = excluded.latest_snapshot_captured_at,
           latest_verdict = excluded.latest_verdict,
           dirty = excluded.dirty,
           provisionally_clean = excluded.provisionally_clean,
           unresolved_records_json = excluded.unresolved_records_json,
           disposition_history_json = excluded.disposition_history_json,
           updated_at = excluded.updated_at`,
      )
      .run({
        id,
        run_uuid: runId,
        scope,
        step,
        dimension: state.dimension,
        latest_snapshot_kind: latestSnapshot?.kind ?? null,
        latest_snapshot_identity: latestSnapshot?.identity ?? null,
        latest_snapshot_base_identity: latestSnapshot?.baseIdentity ?? null,
        latest_snapshot_captured_at: latestSnapshot?.capturedAt ?? null,
        latest_verdict: state.latestVerdict ?? null,
        dirty: state.dirty ? 1 : 0,
        provisionally_clean: state.provisionallyClean ? 1 : 0,
        unresolved_records_json: unresolvedRecordsJson,
        disposition_history_json: dispositionHistoryJson,
        updated_at: new Date().toISOString(),
      });
  }

  listDimensionStates(runId: string, scope: string, step: string): ReviewDimensionState[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM review_dimension_states
         WHERE run_uuid = ? AND scope = ? AND step = ?`,
      )
      .all(runId, scope, step) as DimensionStateRow[];
    return rows.map(rowToDimensionState);
  }
}
