export const version = 19;

export const sql = /* sql */ `
ALTER TABLE pr_review_comments ADD COLUMN severity TEXT;
`;
