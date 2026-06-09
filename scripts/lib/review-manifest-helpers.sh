#!/usr/bin/env bash
# scripts/lib/review-manifest-helpers.sh
# Review-task-manifest validation and deduplication helpers for the issue-to-PR orchestrator.
# Sourced by ai-run-issue-v2 and its bats tests.

_validate_review_manifest() {
  local manifest_path="$1"
  if [[ ! -f "$manifest_path" ]]; then
    return 1
  fi
  if ! jq -e '.' "$manifest_path" >/dev/null 2>&1; then
    echo "review-task-manifest.json is not valid JSON" >&2
    return 2
  fi
  if ! jq -e 'type == "array"' "$manifest_path" >/dev/null 2>&1; then
    echo "review-task-manifest.json is not a JSON array" >&2
    return 3
  fi
  jq '.' "$manifest_path"
  return 0
}

_dedupe_manifest_ids() {
  jq '
    if type != "array" then . else
      . as $tasks |
      reduce range(0; ($tasks | length)) as $i (
        {seen: {}, result: []};
        $tasks[$i] as $task |
        ($task.id // "task-\($i+1)") as $id |
        if .seen[$id] then
          (.seen[$id] + 1) as $new_count |
          .seen[$id] = $new_count |
          .result += [$task | .id = "\($id)-\($new_count)"]
        else
          .seen[$id] = 1 |
          .result += [$task]
        end
      ) | .result
    end
  '
}
