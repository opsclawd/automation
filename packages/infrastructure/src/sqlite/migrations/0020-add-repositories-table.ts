export const version = 20;

export const sql = /* sql */ `
CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL UNIQUE,
  default_branch TEXT NOT NULL,
  local_base_path TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  max_concurrent_runs INTEGER NOT NULL DEFAULT 1,
  config_metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_health_check_at TEXT,
  health_status TEXT NOT NULL DEFAULT 'unknown',
  health_error TEXT
);
`;
