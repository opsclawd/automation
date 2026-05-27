export const version = 4;
export const sql = /* sql */ `
UPDATE agent_invocations
SET phase_id = 'quality-review'
WHERE phase_id = 'review';
UPDATE agent_invocations
SET phase_id = 'post-pr-review'
WHERE phase_id = 'pr-review-poll';
`;
