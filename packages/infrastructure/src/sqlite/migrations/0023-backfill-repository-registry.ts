export const version = 23;

// NOTE: the comment below avoids backticks inside the template literal by using a split string.
const COMMENT_LINE =
  '-- If none exists, leave repositories empty; operators run \`orchestrator repo register\` after this migration on first install.';

export const sql = /* sql */ `
-- Synthetic backfill: pick the most-recent non-'unknown' full_name from runs.config_sources_json
-- (introduced in 0021). ${COMMENT_LINE}
INSERT INTO repositories (
  id, full_name, owner, name, local_base_path, default_branch, remote_url,
  enabled, max_concurrent_runs, config_metadata, health_status,
  health_error, last_health_check_at, created_at, updated_at
)
SELECT
  lower(hex(sha256(printf('synthetic:%s', json_extract(value, '$.fullName'))))),
  json_extract(value, '$.fullName'),
  json_extract(value, '$.owner'),
  json_extract(value, '$.name'),
  json_extract(value, '$.localBasePath'),
  COALESCE(json_extract(value, '$.defaultBranch'), 'main'),
  COALESCE(json_extract(value, '$.remoteUrl'), ''),
  1, 1, '{}', 'unknown', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM runs, json_each(runs.config_sources_json)
WHERE json_extract(value, '$.fullName') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM repositories WHERE repositories.full_name = json_extract(value, '$.fullName'))
GROUP BY json_extract(value, '$.fullName')
ORDER BY COUNT(*) DESC
LIMIT 1;

-- Re-point legacy 'unknown' rows so future joins still resolve.
UPDATE runs
SET repo_id = (SELECT id FROM repositories ORDER BY created_at ASC LIMIT 1)
WHERE repo_id = 'unknown'
  AND EXISTS (SELECT 1 FROM repositories);
`;
