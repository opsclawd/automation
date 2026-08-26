export const version = 36;

export const sql = /* sql */ `
-- Drop dependent views
DROP VIEW IF EXISTS v_cost_by_phase;
DROP VIEW IF EXISTS v_usage_by_run;
DROP VIEW IF EXISTS v_usage_by_phase;

-- Rename old table
ALTER TABLE agent_usage RENAME TO _agent_usage_old;

-- Recreate agent_usage with usage_status and check constraints
CREATE TABLE agent_usage (
  invocation_id TEXT PRIMARY KEY REFERENCES agent_invocations(id) ON DELETE CASCADE,
  run_uuid TEXT NOT NULL REFERENCES runs(uuid) ON DELETE CASCADE,
  phase_id TEXT NOT NULL,
  profile TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  usage_status TEXT NOT NULL CHECK (usage_status IN ('measured', 'unknown')),
  input_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_tokens INTEGER,
  cached_tokens INTEGER,
  recorded_at TEXT NOT NULL,
  CHECK (
    (
      usage_status = 'measured'
      AND input_tokens IS NOT NULL AND input_tokens >= 0
      AND output_tokens IS NOT NULL AND output_tokens >= 0
      AND (reasoning_tokens IS NULL OR reasoning_tokens >= 0)
      AND (cached_tokens IS NULL OR cached_tokens >= 0)
    )
    OR
    (
      usage_status = 'unknown'
      AND input_tokens IS NULL
      AND output_tokens IS NULL
      AND reasoning_tokens IS NULL
      AND cached_tokens IS NULL
    )
  )
);

-- Copy preexisting rows from old table as measured
INSERT INTO agent_usage (
  invocation_id, run_uuid, phase_id, profile, provider, model,
  usage_status, input_tokens, output_tokens, reasoning_tokens, cached_tokens, recorded_at
)
SELECT
  invocation_id, run_uuid, phase_id, profile, provider, model,
  'measured', input_tokens, output_tokens, reasoning_tokens, cached_tokens, recorded_at
FROM _agent_usage_old;

-- Backfill completed invocations without usage as unknown
INSERT INTO agent_usage (
  invocation_id, run_uuid, phase_id, profile, provider, model,
  usage_status, input_tokens, output_tokens, reasoning_tokens, cached_tokens, recorded_at
)
SELECT
  i.id,
  i.run_uuid,
  i.phase_id,
  i.profile,
  i.provider,
  i.model,
  'unknown',
  NULL,
  NULL,
  NULL,
  NULL,
  COALESCE(i.ended_at, i.started_at)
FROM agent_invocations i
WHERE i.ended_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM agent_usage u WHERE u.invocation_id = i.id
  );

-- Drop old table
DROP TABLE _agent_usage_old;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_agent_usage_run ON agent_usage (run_uuid);
CREATE INDEX IF NOT EXISTS idx_agent_usage_phase ON agent_usage (phase_id);
CREATE INDEX IF NOT EXISTS idx_agent_usage_model ON agent_usage (provider, model);

-- Recreate views
CREATE VIEW IF NOT EXISTS v_usage_by_phase AS
SELECT phase_id, profile, provider, model,
       CASE WHEN COUNT(CASE WHEN usage_status = 'measured' THEN 1 END) > 0 THEN SUM(input_tokens) ELSE NULL END AS total_input_tokens,
       CASE WHEN COUNT(CASE WHEN usage_status = 'measured' THEN 1 END) > 0 THEN SUM(output_tokens) ELSE NULL END AS total_output_tokens,
       CASE WHEN COUNT(CASE WHEN usage_status = 'measured' THEN 1 END) > 0 THEN SUM(COALESCE(reasoning_tokens, 0)) ELSE NULL END AS total_reasoning_tokens,
       CASE WHEN COUNT(CASE WHEN usage_status = 'measured' THEN 1 END) > 0 THEN SUM(COALESCE(cached_tokens, 0)) ELSE NULL END AS total_cached_tokens,
       COUNT(CASE WHEN usage_status = 'measured' THEN 1 END) AS invocation_count,
       COUNT(CASE WHEN usage_status = 'unknown' THEN 1 END) AS unknown_invocation_count
FROM agent_usage
GROUP BY phase_id, profile, provider, model;

CREATE VIEW IF NOT EXISTS v_usage_by_run AS
SELECT run_uuid, phase_id, profile, provider, model,
       CASE WHEN COUNT(CASE WHEN usage_status = 'measured' THEN 1 END) > 0 THEN SUM(input_tokens) ELSE NULL END AS total_input_tokens,
       CASE WHEN COUNT(CASE WHEN usage_status = 'measured' THEN 1 END) > 0 THEN SUM(output_tokens) ELSE NULL END AS total_output_tokens,
       CASE WHEN COUNT(CASE WHEN usage_status = 'measured' THEN 1 END) > 0 THEN SUM(COALESCE(reasoning_tokens, 0)) ELSE NULL END AS total_reasoning_tokens,
       CASE WHEN COUNT(CASE WHEN usage_status = 'measured' THEN 1 END) > 0 THEN SUM(COALESCE(cached_tokens, 0)) ELSE NULL END AS total_cached_tokens,
       COUNT(CASE WHEN usage_status = 'measured' THEN 1 END) AS invocation_count,
       COUNT(CASE WHEN usage_status = 'unknown' THEN 1 END) AS unknown_invocation_count
FROM agent_usage
GROUP BY run_uuid, phase_id, profile, provider, model;

CREATE VIEW IF NOT EXISTS v_cost_by_phase AS
SELECT u.phase_id, u.profile, u.provider, u.model,
       CASE WHEN COUNT(CASE WHEN u.usage_status = 'measured' THEN 1 END) > 0 THEN SUM(u.input_tokens) ELSE NULL END AS total_input_tokens,
       CASE WHEN COUNT(CASE WHEN u.usage_status = 'measured' THEN 1 END) > 0 THEN SUM(u.output_tokens) ELSE NULL END AS total_output_tokens,
       CASE WHEN COUNT(CASE WHEN u.usage_status = 'measured' THEN 1 END) > 0 THEN SUM(COALESCE(u.cached_tokens, 0)) ELSE NULL END AS total_cached_tokens,
       CASE
         WHEN COUNT(CASE WHEN u.usage_status = 'measured' THEN 1 END) > 0 THEN
           ROUND(SUM(
             CASE WHEN u.usage_status = 'measured' THEN
               (u.input_tokens - COALESCE(u.cached_tokens, 0))
               * COALESCE(p.input_price_per_1k_tokens, 0) / 1000.0
             + COALESCE(u.cached_tokens, 0)
               * COALESCE(p.cached_input_price_per_1k_tokens, p.input_price_per_1k_tokens, 0) / 1000.0
             + u.output_tokens * COALESCE(p.output_price_per_1k_tokens, 0) / 1000.0
             ELSE 0 END
           ), 6)
         ELSE NULL
       END AS estimated_cost_usd,
       COUNT(CASE WHEN u.usage_status = 'measured' THEN 1 END) AS invocation_count,
       COUNT(CASE WHEN u.usage_status = 'unknown' THEN 1 END) AS unknown_invocation_count
FROM agent_usage u
LEFT JOIN model_prices p ON p.id = (
  SELECT p2.id FROM model_prices p2
  WHERE p2.provider = u.provider AND p2.model = u.model
  AND p2.effective_from <= u.recorded_at
  ORDER BY p2.effective_from DESC
  LIMIT 1
)
GROUP BY u.phase_id, u.profile, u.provider, u.model;
`;
