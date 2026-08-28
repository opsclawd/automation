export const version = 37;

export const sql = /* sql */ `
-- Adds execution_policy column to runs for lean topology control plane.
-- See issue #1091.

ALTER TABLE runs ADD COLUMN execution_policy TEXT;

UPDATE runs
SET execution_policy = 'legacy'
WHERE execution_policy IS NULL;
`;
