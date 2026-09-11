export const version = 38;

export const sql = /* sql */ `
-- Creates release_batches and release_batch_items tables for autonomous release batches.
-- See issue #1195.

CREATE TABLE IF NOT EXISTS release_batches (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  source_branch TEXT NOT NULL,
  source_start_sha TEXT NOT NULL,
  release_branch TEXT NOT NULL,
  status TEXT NOT NULL,
  current_position INTEGER NOT NULL,
  candidate_sha TEXT,
  approved_candidate_sha TEXT,
  blocked_reason TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_release_batches_repo_status
  ON release_batches (repo_id, status);
CREATE INDEX IF NOT EXISTS idx_release_batches_created_at
  ON release_batches (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_release_batches_release_branch
  ON release_batches (repo_id, release_branch);

CREATE TABLE IF NOT EXISTS release_batch_items (
  release_batch_id TEXT NOT NULL REFERENCES release_batches(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  issue_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  run_uuid TEXT,
  pr_number INTEGER,
  base_sha TEXT,
  merged_commit_sha TEXT,
  blocked_reason TEXT,
  started_at TEXT,
  completed_at TEXT,
  PRIMARY KEY (release_batch_id, position)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_release_batch_items_batch_issue
  ON release_batch_items (release_batch_id, issue_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_release_batch_items_run_uuid
  ON release_batch_items (run_uuid) WHERE run_uuid IS NOT NULL;
`;
