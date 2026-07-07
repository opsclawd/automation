import { createHash } from 'node:crypto';

export const version = 22;

export const sql = /* sql */ `
CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL UNIQUE,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  local_base_path TEXT NOT NULL UNIQUE,
  default_branch TEXT NOT NULL,
  remote_url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  max_concurrent_runs INTEGER NOT NULL DEFAULT 1,
  config_metadata TEXT NOT NULL DEFAULT '{}',
  health_status TEXT NOT NULL DEFAULT 'unknown',
  health_error TEXT,
  last_health_check_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_repositories_enabled ON repositories(enabled);

CREATE TRIGGER trg_repositories_updated_at
AFTER UPDATE ON repositories
FOR EACH ROW
BEGIN
  UPDATE repositories SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = OLD.id;
END;
`;

export const BACKFILL_REPOSITORY_ID = (fullName: string): string =>
  createHash('sha256').update(fullName).digest('hex');
