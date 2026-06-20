export const version = 12;

export const sql = /* sql */ `
ALTER TABLE runs ADD COLUMN start_commit_sha TEXT;
`;
