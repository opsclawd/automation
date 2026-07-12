export const version = 26;

export const sql = /* sql */ `
CREATE TABLE IF NOT EXISTS pr_review_comment_attempts (
  attempt_id TEXT PRIMARY KEY,
  run_uuid TEXT NOT NULL REFERENCES runs(uuid) ON DELETE CASCADE,
  comment_id INTEGER NOT NULL,
  retry_number INTEGER NOT NULL,
  start_head TEXT NOT NULL,
  completed_head TEXT,
  review_mode TEXT NOT NULL,
  prompt_path TEXT NOT NULL,
  result_artifact_path TEXT NOT NULL,
  action TEXT NOT NULL,
  verifier_feedback TEXT,
  build_feedback TEXT,
  disposition TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_uuid, comment_id) REFERENCES pr_review_comments(run_uuid, comment_id) ON DELETE CASCADE,
  UNIQUE (run_uuid, comment_id, retry_number)
);
CREATE INDEX IF NOT EXISTS idx_pr_review_comment_attempts_run
  ON pr_review_comment_attempts (run_uuid, created_at);
`;
