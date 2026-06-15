export const version = 8;

export const sql = /* sql */ `
CREATE TABLE IF NOT EXISTS loops (
  id TEXT PRIMARY KEY,
  run_uuid TEXT NOT NULL REFERENCES runs(uuid) ON DELETE CASCADE,
  phase_id TEXT NOT NULL,
  type TEXT NOT NULL,
  max_iterations INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS loop_iterations (
  loop_id TEXT NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  review_invocation_id TEXT NOT NULL,
  fix_invocation_id TEXT,
  revalidation_id TEXT,
  outcome TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (loop_id, idx)
);

CREATE INDEX IF NOT EXISTS idx_loops_run ON loops (run_uuid, phase_id);
`;
