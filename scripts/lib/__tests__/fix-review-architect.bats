#!/usr/bin/env bats

# Tests for the cohesive architect pass helpers

setup() {
  SCRIPT_DIR="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  source "${SCRIPT_DIR}/review-manifest-helpers.sh"
  TMPDIR_TEST="$(mktemp -d)"
  export ISSUES_DIR="$TMPDIR_TEST"
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

# ── _extract_architect_plan_entry tests ──────────────────────────────────

@test "_extract_architect_plan_entry: returns correct entry for existing task_id" {
  cat > "$TMPDIR_TEST/review-fix-plan.json" << 'JSON'
{"version":1,"tasks":[{"task_id":"C1","approach":"Check before loop","conflicts_resolved":["CONF-005"],"constraints":["Must not use for-in with set -u"],"depends_on":[]}]}
JSON
  run _extract_architect_plan_entry "$TMPDIR_TEST/review-fix-plan.json" "C1"
  [[ $status -eq 0 ]]
  [[ $(echo "$output" | jq -r '.task_id') == "C1" ]]
  [[ $(echo "$output" | jq -r '.approach') == "Check before loop" ]]
}

@test "_extract_architect_plan_entry: returns empty for missing task_id" {
  cat > "$TMPDIR_TEST/review-fix-plan.json" << 'JSON'
{"version":1,"tasks":[{"task_id":"C1","approach":"Check before loop","conflicts_resolved":[],"constraints":[],"depends_on":[]}]}
JSON
  run _extract_architect_plan_entry "$TMPDIR_TEST/review-fix-plan.json" "H2"
  [[ $status -eq 0 ]]
  [[ -z "$output" ]]
}

@test "_extract_architect_plan_entry: handles missing file gracefully" {
  run _extract_architect_plan_entry "$TMPDIR_TEST/nonexistent.json" "C1"
  [[ $status -eq 0 ]]
  [[ -z "$output" ]]
}

@test "_extract_architect_plan_entry: handles malformed JSON gracefully" {
  echo "not json" > "$TMPDIR_TEST/review-fix-plan.json"
  run _extract_architect_plan_entry "$TMPDIR_TEST/review-fix-plan.json" "C1"
  [[ $status -eq 0 ]]
  [[ -z "$output" ]]
}

@test "_extract_architect_plan_entry: handles valid JSON with wrong structure gracefully" {
  echo '{"key":"value"}' > "$TMPDIR_TEST/review-fix-plan.json"
  run _extract_architect_plan_entry "$TMPDIR_TEST/review-fix-plan.json" "C1"
  [[ $status -eq 0 ]]
  [[ -z "$output" ]]
}
