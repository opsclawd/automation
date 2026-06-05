export const version = 6;

export const sql = /* sql */ `
CREATE TABLE IF NOT EXISTS pr_review_comments (
  run_uuid TEXT NOT NULL REFERENCES runs(uuid) ON DELETE CASCADE,
  pr_number INTEGER NOT NULL,
  comment_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  reviewer TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  outcome TEXT,
  reply_id INTEGER,
  commit_sha TEXT,
  commit_verified INTEGER NOT NULL DEFAULT 0,
  reply_verified INTEGER NOT NULL DEFAULT 0,
  build_verified INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  last_poll INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_uuid, comment_id)
);

CREATE TABLE IF NOT EXISTS pr_review_replies (
  id TEXT PRIMARY KEY,
  run_uuid TEXT NOT NULL REFERENCES runs(uuid) ON DELETE CASCADE,
  pr_number INTEGER NOT NULL,
  comment_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS poll_attempts (
  id TEXT PRIMARY KEY,
  run_uuid TEXT NOT NULL REFERENCES runs(uuid) ON DELETE CASCADE,
  pr_number INTEGER NOT NULL,
  poll_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  comments_fetched INTEGER NOT NULL DEFAULT 0,
  comments_processed INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  next_poll_at TEXT,
  terminal_state TEXT
);

CREATE INDEX IF NOT EXISTS idx_pr_review_comments_run
  ON pr_review_comments (run_uuid, state);
CREATE INDEX IF NOT EXISTS idx_pr_review_replies_run
  ON pr_review_replies (run_uuid, comment_id);
CREATE INDEX IF NOT EXISTS idx_poll_attempts_run
  ON poll_attempts (run_uuid, poll_number);
`;
