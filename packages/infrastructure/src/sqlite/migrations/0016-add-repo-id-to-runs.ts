export const version = 16;

export const sql = /* sql */ `
ALTER TABLE runs ADD COLUMN repo_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_runs_repo_id_issue ON runs (repo_id, issue_number);
`;
