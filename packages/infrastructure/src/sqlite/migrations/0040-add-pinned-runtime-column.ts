export const version = 40;

export const sql = /* sql */ `
-- Adds pinned_runtime column to runs table.
-- See issue #1230.

ALTER TABLE runs ADD COLUMN pinned_runtime TEXT;
`;
