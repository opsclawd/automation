export const version = 2;

export const sql = /* sql */ `
ALTER TABLE runs ADD COLUMN pid INTEGER;
`;
