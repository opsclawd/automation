export const version = 1;

export const sql = /* sql */ `
CREATE TABLE IF NOT EXISTS runs (
  uuid TEXT PRIMARY KEY,
  display_id TEXT NOT NULL UNIQUE,
  issue_number INTEGER NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  current_phase TEXT,
  completed_phases TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  failure_reason TEXT,
  exit_code INTEGER,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_issue_status ON runs (issue_number, status);
CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs (started_at DESC);

CREATE TABLE IF NOT EXISTS phases (
  id TEXT PRIMARY KEY,
  run_uuid TEXT NOT NULL REFERENCES runs(uuid) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_phases_run ON phases (run_uuid, name);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_uuid TEXT NOT NULL REFERENCES runs(uuid) ON DELETE CASCADE,
  phase TEXT,
  level TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_run_ts ON events (run_uuid, timestamp);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  run_uuid TEXT NOT NULL REFERENCES runs(uuid) ON DELETE CASCADE,
  phase TEXT,
  type TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts (run_uuid);

CREATE TABLE IF NOT EXISTS failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_uuid TEXT NOT NULL REFERENCES runs(uuid) ON DELETE CASCADE,
  phase TEXT,
  step TEXT,
  attempt INTEGER,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  exit_code INTEGER,
  can_retry INTEGER NOT NULL,
  suggested_action TEXT NOT NULL,
  artifacts TEXT NOT NULL DEFAULT '[]',
  detected_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_failures_run ON failures (run_uuid);
`;
