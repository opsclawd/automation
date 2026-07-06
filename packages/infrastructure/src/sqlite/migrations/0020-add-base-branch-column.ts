export const version = 20;

export const sql = /* sql */ `
ALTER TABLE runs ADD COLUMN base_branch TEXT;
`;
