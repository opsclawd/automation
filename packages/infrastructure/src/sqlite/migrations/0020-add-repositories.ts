export const version = 20;

export const sql = /* sql */ `
CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL UNIQUE,
  default_branch TEXT NOT NULL,
  local_base_path TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  max_concurrent_runs INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
