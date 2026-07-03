export const version = 18;

export const sql = /* sql */ `
ALTER TABLE jobs ADD COLUMN claim_expires_at TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_status_claimed_at ON jobs(status, claimed_at);
`;
