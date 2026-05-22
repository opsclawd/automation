export const version = 3;

export const sql = /* sql */ `
CREATE TABLE IF NOT EXISTS agent_invocations (
  id TEXT PRIMARY KEY,
  run_uuid TEXT NOT NULL REFERENCES runs(uuid) ON DELETE CASCADE,
  phase_id TEXT NOT NULL,
  step_id TEXT,
  profile TEXT NOT NULL,
  runtime TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  skill TEXT,
  prompt_path TEXT NOT NULL,
  prompt_chars INTEGER NOT NULL,
  prompt_tokens_approx INTEGER,
  stdout_path TEXT NOT NULL,
  stderr_path TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  start_commit_sha TEXT NOT NULL,
  end_commit_sha TEXT,
  exit_code INTEGER,
  duration_ms INTEGER,
  timeout_ms INTEGER NOT NULL,
  outcome TEXT,
  contract_violations TEXT NOT NULL DEFAULT '[]',
  result_json_path TEXT,
  fallback_of_invocation_id TEXT REFERENCES agent_invocations(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_invocations_run_phase
  ON agent_invocations (run_uuid, phase_id);
CREATE INDEX IF NOT EXISTS idx_agent_invocations_fallback_of
  ON agent_invocations (fallback_of_invocation_id);
`;
