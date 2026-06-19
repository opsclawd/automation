export const version = 11;

export const sql = /* sql */ `
ALTER TABLE runs ADD COLUMN skipped_phases TEXT NOT NULL DEFAULT '[]';
`;
