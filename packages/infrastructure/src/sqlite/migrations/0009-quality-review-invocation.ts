export const version = 9;

export const sql = /* sql */ `
ALTER TABLE loop_iterations ADD COLUMN quality_review_invocation_id TEXT;
`;
