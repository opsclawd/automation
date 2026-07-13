export const version = 28;

export const sql = /* sql */ `
ALTER TABLE workers ADD COLUMN repo_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_workers_repo_status_heartbeat ON workers (repo_id, status, heartbeat_at);
`;
