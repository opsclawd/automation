export const version = 27;

export const sql = /* sql */ `
CREATE INDEX IF NOT EXISTS idx_jobs_repo_status_priority_created_id
  ON jobs (repo_id, status, priority DESC, created_at ASC, id ASC);
`;
