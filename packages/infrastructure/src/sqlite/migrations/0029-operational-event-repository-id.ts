export const version = 29;

export const sql = /* sql */ `
ALTER TABLE events ADD COLUMN repo_id TEXT;
UPDATE events SET repo_id = (
  SELECT repo_id FROM runs WHERE runs.uuid = events.run_uuid
) WHERE repo_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_events_repo_timestamp ON events (repo_id, timestamp);
`;
