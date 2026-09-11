export const version = 39;

export const sql = /* sql */ `
-- Adds candidate_tree_sha, promotion_commit_sha, and promotion_pr_number to release_batches table.
-- See issue #1199.

ALTER TABLE release_batches ADD COLUMN candidate_tree_sha TEXT;
ALTER TABLE release_batches ADD COLUMN promotion_commit_sha TEXT;
ALTER TABLE release_batches ADD COLUMN promotion_pr_number INTEGER;
`;
