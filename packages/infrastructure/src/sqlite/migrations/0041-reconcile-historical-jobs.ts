export const version = 41;

export const sql = /* sql */ `
-- Reconcile historical non-terminal jobs for runs that are already terminal
UPDATE jobs
SET status = CASE
      WHEN runs.status = 'passed' THEN 'succeeded'
      WHEN runs.status = 'cancelled' THEN 'cancelled'
      ELSE 'failed'
    END,
    completed_at = COALESCE(runs.completed_at, CURRENT_TIMESTAMP),
    claimed_by = NULL,
    claim_token = NULL,
    claim_expires_at = NULL
FROM runs
WHERE jobs.run_id = runs.uuid
  AND jobs.status IN ('queued', 'claimed', 'running')
  AND runs.status IN ('passed', 'failed', 'cancelled');
`;
