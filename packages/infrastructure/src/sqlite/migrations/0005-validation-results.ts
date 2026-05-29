export const version = 5;

export const sql = /* sql */ `
CREATE TABLE IF NOT EXISTS validation_runs (
  id TEXT PRIMARY KEY,
  run_uuid TEXT NOT NULL REFERENCES runs(uuid) ON DELETE CASCADE,
  phase_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS validation_command_results (
  id TEXT PRIMARY KEY,
  validation_run_id TEXT NOT NULL REFERENCES validation_runs(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  command TEXT NOT NULL,
  exit_code INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  stdout_path TEXT NOT NULL,
  stderr_path TEXT NOT NULL,
  outcome TEXT NOT NULL,
  kind TEXT,
  classifier TEXT
);

CREATE INDEX IF NOT EXISTS idx_validation_runs_run
  ON validation_runs (run_uuid);
CREATE INDEX IF NOT EXISTS idx_validation_cmd_results_run
  ON validation_command_results (validation_run_id, ordinal);
`;
