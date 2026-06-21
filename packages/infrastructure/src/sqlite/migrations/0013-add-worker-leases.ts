export const version = 13;

export const sql = /* sql */ `
CREATE TABLE worker_leases (
  repo_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`;
