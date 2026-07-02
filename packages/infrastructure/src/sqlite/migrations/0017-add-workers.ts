export const version = 17;

export const sql = /* sql */ `
CREATE TABLE IF NOT EXISTS workers (
  id           TEXT    PRIMARY KEY,
  hostname     TEXT    NOT NULL,
  process_id   INTEGER NOT NULL,
  status       TEXT    NOT NULL,
  heartbeat_at TEXT    NOT NULL
);
`;
