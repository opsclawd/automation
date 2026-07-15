export const version = 31;

export const sql = /* sql */ `
ALTER TABLE jobs ADD COLUMN claim_token TEXT;

UPDATE jobs SET claim_token = lower(hex(randomblob(16)))
WHERE status IN ('claimed', 'running');

CREATE INDEX IF NOT EXISTS idx_jobs_fence ON jobs(status, claimed_by, claim_token);
`;
