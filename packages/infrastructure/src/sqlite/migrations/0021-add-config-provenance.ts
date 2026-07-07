export const version = 21;

export const sql = /* sql */ `
-- Adds config provenance to runs. See docs/superpowers/plans/2026-07-06-target-config-overrides.md §4.5.
-- The backfill uses a single literal SHA256 representing the cutover-time config.

ALTER TABLE runs ADD COLUMN config_fingerprint TEXT;
ALTER TABLE runs ADD COLUMN config_sources_json TEXT;

UPDATE runs
SET
  config_fingerprint = '19d021bbabac38fc537e2fee672bb5ce6a06c5a7cfcc661c762955f8893c4e25',
  config_sources_json = '[]'
WHERE config_fingerprint IS NULL;
`;
