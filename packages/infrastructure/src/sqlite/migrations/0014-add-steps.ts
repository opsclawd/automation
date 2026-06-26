export const version = 14;

export const sql = /* sql */ `
CREATE TABLE IF NOT EXISTS steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TEXT,
  completed_at TEXT,
  UNIQUE(run_id, phase_id, idx)
);

CREATE INDEX IF NOT EXISTS idx_steps_run_id ON steps (run_id);
`;
