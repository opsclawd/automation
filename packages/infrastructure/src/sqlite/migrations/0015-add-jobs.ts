export const version = 15;

export const sql = /* sql */ `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_priority_created
  ON jobs (status, priority DESC, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_jobs_repo_id ON jobs (repo_id);
CREATE INDEX IF NOT EXISTS idx_jobs_run_id ON jobs (run_id);
`;
