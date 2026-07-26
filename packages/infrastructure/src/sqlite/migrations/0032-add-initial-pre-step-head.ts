export const version = 32;

export const sql = /* sql */ `
ALTER TABLE steps ADD COLUMN initial_pre_step_head TEXT;
`;
