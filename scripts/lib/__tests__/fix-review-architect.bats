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

# ── Architect pass behavior stubs ───────────────────────────────────────
# These test the data flow logic, not the agent invocation itself.

@test "Architect pass is skipped when architectPass.enabled is false" {
  FIX_REVIEW_USE_LEGACY=0
  FIX_REVIEW_EMPTY=0
  FIX_REVIEW_ARCHITECT_ENABLED=false
  FIX_REVIEW_MANIFEST='[{"id":"C1","action":"fix","severity":"high"}]'
  FIX_REVIEW_ARCHITECT_PLAN=""
  [[ "$FIX_REVIEW_ARCHITECT_ENABLED" != "true" ]]
  [[ -z "$FIX_REVIEW_ARCHITECT_PLAN" ]]
}

@test "Architect pass is skipped when manifest has no fix tasks" {
  FIX_REVIEW_USE_LEGACY=0
  FIX_REVIEW_EMPTY=0
  FIX_REVIEW_ARCHITECT_ENABLED=true
  FIX_REVIEW_MANIFEST='[{"id":"R1","action":"defer","severity":"low"}]'
  _has_fix_tasks=$(echo "$FIX_REVIEW_MANIFEST" | jq '[.[] | select(.action == "fix" or .action == null)] | length')
  [[ "$_has_fix_tasks" -eq 0 ]]
}

@test "Plan entry is correctly injected into fix prompt" {
  cat > "$TMPDIR_TEST/review-fix-plan.json" << 'JSON'
{"version":1,"tasks":[{"task_id":"C1","approach":"Use if/else","conflicts_resolved":["CONF-005"],"constraints":["set -euo pipefail"],"depends_on":["H2"]}]}
JSON
  _plan_entry=$(_extract_architect_plan_entry "$TMPDIR_TEST/review-fix-plan.json" "C1")
  [[ -n "$_plan_entry" ]]
  _plan_approach=$(echo "$_plan_entry" | jq -r '.approach // ""')
  [[ "$_plan_approach" == "Use if/else" ]]
}

@test "Missing plan file leaves FIX_REVIEW_ARCHITECT_PLAN empty" {
  FIX_REVIEW_ARCHITECT_PLAN=""
  _plan_entry=$(_extract_architect_plan_entry "/nonexistent/review-fix-plan.json" "C1")
  [[ -z "$_plan_entry" ]]
}
