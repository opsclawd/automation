export const version = 16;

export const sql = /* sql */ `
ALTER TABLE runs ADD COLUMN repo_id TEXT;
CREATE INDEX IF NOT EXISTS idx_runs_repo_issue_status ON runs (repo_id, issue_number, status);
`;
