export const version = 34;

export const sql = /* sql */ `
ALTER TABLE steps ADD COLUMN revert_counts TEXT NOT NULL DEFAULT '{}';
`;
