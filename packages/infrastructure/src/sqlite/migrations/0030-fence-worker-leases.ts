export const version = 30;

export const sql = /* sql */ `
-- Rename old table
ALTER TABLE worker_leases RENAME TO worker_leases_old;

-- Create new table with NOT NULL constraint on lease_token and a random default
CREATE TABLE worker_leases (
  repo_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  lease_token TEXT NOT NULL DEFAULT (lower(hex(randomblob(16))))
);

-- Copy and backfill data generating random hex tokens for any missing
INSERT INTO worker_leases (repo_id, worker_id, run_id, acquired_at, heartbeat_at, expires_at, lease_token)
SELECT repo_id, worker_id, run_id, acquired_at, heartbeat_at, expires_at, lower(hex(randomblob(16)))
FROM worker_leases_old;

-- Drop old table
DROP TABLE worker_leases_old;

-- Index the exact fenced tuple
CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_leases_fence ON worker_leases (repo_id, worker_id, run_id, lease_token);
`;
