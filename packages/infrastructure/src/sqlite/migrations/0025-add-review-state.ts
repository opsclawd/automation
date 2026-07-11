export const version = 25;

export const sql = /* sql */ `
CREATE TABLE IF NOT EXISTS review_attempts (
  id TEXT PRIMARY KEY,
  run_uuid TEXT NOT NULL,
  scope TEXT NOT NULL,
  step TEXT NOT NULL,
  review_mode TEXT NOT NULL,
  dimension TEXT NOT NULL,
  snapshot_kind TEXT,
  snapshot_identity TEXT,
  snapshot_base_identity TEXT,
  snapshot_captured_at TEXT,
  verdict TEXT,
  created_at TEXT NOT NULL,
  artifacts_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_review_attempts_run_scope ON review_attempts(run_uuid, scope, step, dimension);
CREATE INDEX IF NOT EXISTS idx_review_attempts_created_at ON review_attempts(created_at);

CREATE TABLE IF NOT EXISTS review_dimension_states (
  id TEXT PRIMARY KEY,
  run_uuid TEXT NOT NULL,
  scope TEXT NOT NULL,
  step TEXT NOT NULL,
  dimension TEXT NOT NULL,
  latest_snapshot_kind TEXT,
  latest_snapshot_identity TEXT,
  latest_snapshot_base_identity TEXT,
  latest_snapshot_captured_at TEXT,
  latest_verdict TEXT,
  dirty INTEGER NOT NULL DEFAULT 0,
  provisionally_clean INTEGER NOT NULL DEFAULT 0,
  unresolved_records_json TEXT NOT NULL DEFAULT '[]',
  disposition_history_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_review_dimension_states_run_scope ON review_dimension_states(run_uuid, scope, step);
`;
