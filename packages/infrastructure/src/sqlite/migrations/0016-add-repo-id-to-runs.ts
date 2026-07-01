export const version = 16;

export const sql = /* sql */ `
ALTER TABLE runs ADD COLUMN repo_id TEXT;
UPDATE runs SET repo_id = 'unknown' WHERE repo_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_runs_repo_issue_status ON runs (repo_id, issue_number, status);
`;
