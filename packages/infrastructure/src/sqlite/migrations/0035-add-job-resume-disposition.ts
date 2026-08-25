export const version = 35;

export const sql = /* sql */ `
ALTER TABLE jobs ADD COLUMN resume_disposition TEXT;
`;
