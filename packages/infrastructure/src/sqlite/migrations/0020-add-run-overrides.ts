export const version = 20;

export const sql = /* sql */ `
ALTER TABLE runs ADD COLUMN base_branch TEXT;
ALTER TABLE runs ADD COLUMN model_override TEXT;
ALTER TABLE runs ADD COLUMN runtime_override TEXT;
`;
