export const version = 7;

export const sql = /* sql */ `
CREATE TABLE IF NOT EXISTS agent_usage (
  invocation_id TEXT PRIMARY KEY REFERENCES agent_invocations(id) ON DELETE CASCADE,
  run_uuid TEXT NOT NULL REFERENCES runs(uuid) ON DELETE CASCADE,
  phase_id TEXT NOT NULL,
  profile TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER,
  cached_tokens INTEGER,
  recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_usage_run ON agent_usage (run_uuid);
CREATE INDEX IF NOT EXISTS idx_agent_usage_phase ON agent_usage (phase_id);
CREATE INDEX IF NOT EXISTS idx_agent_usage_model ON agent_usage (provider, model);

CREATE TABLE IF NOT EXISTS model_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  input_price_per_1k_tokens REAL NOT NULL,
  output_price_per_1k_tokens REAL NOT NULL,
  cached_input_price_per_1k_tokens REAL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_model_prices_lookup
  ON model_prices (provider, model, effective_from);

CREATE VIEW IF NOT EXISTS v_usage_by_phase AS
SELECT phase_id, profile, provider, model,
       SUM(input_tokens) AS total_input_tokens,
       SUM(output_tokens) AS total_output_tokens,
       SUM(COALESCE(reasoning_tokens, 0)) AS total_reasoning_tokens,
       SUM(COALESCE(cached_tokens, 0)) AS total_cached_tokens,
       COUNT(*) AS invocation_count
FROM agent_usage
GROUP BY phase_id, profile, provider, model;

CREATE VIEW IF NOT EXISTS v_usage_by_run AS
SELECT run_uuid, phase_id, profile, provider, model,
       SUM(input_tokens) AS total_input_tokens,
       SUM(output_tokens) AS total_output_tokens,
       SUM(COALESCE(reasoning_tokens, 0)) AS total_reasoning_tokens,
       SUM(COALESCE(cached_tokens, 0)) AS total_cached_tokens,
       COUNT(*) AS invocation_count
FROM agent_usage
GROUP BY run_uuid, phase_id, profile, provider, model;

CREATE VIEW IF NOT EXISTS v_cost_by_phase AS
SELECT u.phase_id, u.profile, u.provider, u.model,
       SUM(u.input_tokens) AS total_input_tokens,
       SUM(u.output_tokens) AS total_output_tokens,
       SUM(u.input_tokens * COALESCE(p.input_price_per_1k_tokens, 0) / 1000.0
         + u.output_tokens * COALESCE(p.output_price_per_1k_tokens, 0) / 1000.0)
         AS estimated_cost_usd,
       COUNT(*) AS invocation_count
FROM agent_usage u
LEFT JOIN model_prices p ON p.provider = u.provider
  AND p.model = u.model
  AND p.effective_from <= u.recorded_at
  AND (p.effective_from = (
    SELECT MAX(p2.effective_from) FROM model_prices p2
    WHERE p2.provider = u.provider AND p2.model = u.model
    AND p2.effective_from <= u.recorded_at
  ))
GROUP BY u.phase_id, u.profile, u.provider, u.model;
`;
