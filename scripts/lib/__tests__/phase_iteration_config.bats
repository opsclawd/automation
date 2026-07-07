#!/usr/bin/env bats

# Tests for phase iteration limit config reading in ai-run-issue-v2.
# We extract the config-reading block via awk and test it in isolation.

setup() {
  TMPDIR_TEST="$(mktemp -d)"
  REPO_ROOT="$TMPDIR_TEST"
  LOG_OUTPUT=""
  # Stub log to capture output
  log() { LOG_OUTPUT="${LOG_OUTPUT}$*\n"; }
  # Stub warn likewise — the config-load block may warn() on a malformed local
  # config fallback; without this stub the eval'd block dies with
  # "warn: command not found" (status 127). Captured into LOG_OUTPUT so tests
  # can assert the warning fired.
  warn() { LOG_OUTPUT="${LOG_OUTPUT}WARN: $*\n"; }
  # Stub mkdir — the config-reading block ensures ISSUES_DIR exists before
  # the first log() call so tee -a doesn't fail under set -euo pipefail.
  # Tests evaluate that block in isolation, so we no-op the side effect.
  mkdir() { :; }
  # Stub mktemp to create a predictable file in the test temp dir. Only
  # invoked when a local config file is present (new override tests).
  mktemp() { echo "${TMPDIR_TEST}/.merged-config.json"; }
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

# Extract the config-reading block from the script.
# The block starts at the "# ── Phase iteration limits" comment and ends
# at the log line that follows the fi.
_load_config_block() {
  SCRIPT_PATH="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/legacy/ai-run-issue-v2"
  eval "$(awk '
    /# ── Phase iteration limits from config/ { found=1 }
    found {
      print
      if (/^log "Config:/) { found=0 }
    }
  ' "$SCRIPT_PATH")"
}

setup_repo_root() {
  local filename="$1"
  local content="$2"
  local repo_dir="${TMPDIR_TEST}/repo"
  command mkdir -p "$repo_dir"
  echo "$content" > "${repo_dir}/${filename}"
  REPO_ROOT="$repo_dir"
}

load_layered_config() {
  local repo_root="$1"
  REPO_ROOT="$repo_root"
  REPO_TARGET=""
  _load_config_block
  echo "$_ACTIVE_CONFIG" > "${TMPDIR_TEST}/last_active_config"
}

_update_active_config() {
  if [ -f "${TMPDIR_TEST}/last_active_config" ]; then
    _ACTIVE_CONFIG="$(cat "${TMPDIR_TEST}/last_active_config")"
  fi
}

assert_failure() {
  _update_active_config
  local expected_status="${1:-}"
  if [ "$status" -eq 0 ]; then
    echo "Expected non-zero exit status, but got 0"
    return 1
  fi
  if [ -n "$expected_status" ] && [ "$status" -ne "$expected_status" ]; then
    echo "Expected status $expected_status, but got $status"
    echo "Output: $output"
    return 1
  fi
}

assert_output() {
  local arg="$1"
  local val="$2"
  if [ "$arg" = "--partial" ]; then
    if [[ "$output" != *"$val"* ]]; then
      echo "Expected output to contain: '$val'"
      echo "Actual output: '$output'"
      return 1
    fi
  fi
}


@test "defaults: when config file is missing, defaults are 5, 10, 2" {
  _load_config_block
  [ "$MAX_REVIEW_FIX_ITERATIONS" = "5" ]
  [ "$MAX_WHOLE_PR_FIX_ITERATIONS" = "10" ]
  [ "$MAX_FIX_VALIDATE_ITERATIONS" = "2" ]
}

@test "reads reviewFix.maxIterations from config" {
  echo '{"phases":{"reviewFix":{"maxIterations":7},"implement":{"maxIterations":5}}}' > "$TMPDIR_TEST/.ai-orchestrator.json"
  _load_config_block
  [ "$MAX_REVIEW_FIX_ITERATIONS" = "7" ]
}

@test "reads wholePrFix.maxIterations from config" {
  echo '{"phases":{"reviewFix":{"maxIterations":10},"implement":{"maxIterations":5},"wholePrFix":{"maxIterations":15}}}' > "$TMPDIR_TEST/.ai-orchestrator.json"
  _load_config_block
  [ "$MAX_WHOLE_PR_FIX_ITERATIONS" = "15" ]
}

@test "falls back to default when wholePrFix key is absent" {
  echo '{"phases":{"reviewFix":{"maxIterations":10},"implement":{"maxIterations":5}}}' > "$TMPDIR_TEST/.ai-orchestrator.json"
  _load_config_block
  [ "$MAX_WHOLE_PR_FIX_ITERATIONS" = "10" ]
}

@test "falls back to defaults on malformed JSON" {
  echo 'not json at all' > "$TMPDIR_TEST/.ai-orchestrator.json"
  _load_config_block
  [ "$MAX_REVIEW_FIX_ITERATIONS" = "5" ]
  [ "$MAX_WHOLE_PR_FIX_ITERATIONS" = "10" ]
}

@test "rejects zero as maxIterations, falls back to default" {
  echo '{"phases":{"reviewFix":{"maxIterations":0},"implement":{"maxIterations":5}}}' > "$TMPDIR_TEST/.ai-orchestrator.json"
  _load_config_block
  [ "$MAX_REVIEW_FIX_ITERATIONS" = "5" ]
}

@test "logs effective limits on startup" {
  echo '{"phases":{"reviewFix":{"maxIterations":8},"implement":{"maxIterations":5},"wholePrFix":{"maxIterations":12}}}' > "$TMPDIR_TEST/.ai-orchestrator.json"
  _load_config_block
  [[ "$LOG_OUTPUT" == *"reviewFix.maxIterations=8"* ]]
  [[ "$LOG_OUTPUT" == *"wholePrFix.maxIterations=12"* ]]
}

@test "reads fixValidate.maxIterations from config" {
  echo '{"phases":{"reviewFix":{"maxIterations":10},"implement":{"maxIterations":5},"fixValidate":{"maxIterations":3}}}' > "$TMPDIR_TEST/.ai-orchestrator.json"
  _load_config_block
  [ "$MAX_FIX_VALIDATE_ITERATIONS" = "3" ]
}

@test "falls back to default when fixValidate key is absent" {
  echo '{"phases":{"reviewFix":{"maxIterations":10},"implement":{"maxIterations":5}}}' > "$TMPDIR_TEST/.ai-orchestrator.json"
  _load_config_block
  [ "$MAX_FIX_VALIDATE_ITERATIONS" = "2" ]
}

@test "logs fixValidate.maxIterations on startup" {
  echo '{"phases":{"reviewFix":{"maxIterations":8},"implement":{"maxIterations":5},"fixValidate":{"maxIterations":1}}}' > "$TMPDIR_TEST/.ai-orchestrator.json"
  _load_config_block
  [[ "$LOG_OUTPUT" == *"fixValidate.maxIterations=1"* ]]
}

@test "reads fixValidate.enabled=false from config" {
  echo '{"phases":{"reviewFix":{"maxIterations":5},"implement":{"maxIterations":5},"fixValidate":{"maxIterations":2,"enabled":false}}}' > "$TMPDIR_TEST/.ai-orchestrator.json"
  _load_config_block
  [ "$FIX_VALIDATE_ENABLED" = "false" ]
}

@test "defaults fixValidate.enabled to true when absent" {
  echo '{"phases":{"reviewFix":{"maxIterations":5},"implement":{"maxIterations":5}}}' > "$TMPDIR_TEST/.ai-orchestrator.json"
  _load_config_block
  [ "$FIX_VALIDATE_ENABLED" = "true" ]
}

@test "logs fixValidate.enabled on startup" {
  echo '{"phases":{"reviewFix":{"maxIterations":5},"implement":{"maxIterations":5},"fixValidate":{"maxIterations":2,"enabled":false}}}' > "$TMPDIR_TEST/.ai-orchestrator.json"
  _load_config_block
  [[ "$LOG_OUTPUT" == *"fixValidate.enabled=false"* ]]
}

@test "reads planReview.enabled from local config override" {
  echo '{"phases":{"reviewFix":{"maxIterations":5},"implement":{"maxIterations":5},"planReview":{"enabled":false}}}' > "$TMPDIR_TEST/.ai-orchestrator.json"
  echo '{"phases":{"planReview":{"enabled":true}}}' > "$TMPDIR_TEST/.ai-orchestrator.local.json"
  _load_config_block
  [ "$PLAN_REVIEW_ENABLED" = "true" ]
}

@test "reads reviewFix.maxIterations from local config override" {
  echo '{"phases":{"reviewFix":{"maxIterations":3},"implement":{"maxIterations":5}}}' > "$TMPDIR_TEST/.ai-orchestrator.json"
  echo '{"phases":{"reviewFix":{"maxIterations":9}}}' > "$TMPDIR_TEST/.ai-orchestrator.local.json"
  _load_config_block
  [ "$MAX_REVIEW_FIX_ITERATIONS" = "9" ]
}

@test "deep merge: local overrides a single key, base provides the rest" {
  echo '{"phases":{"reviewFix":{"maxIterations":5},"implement":{"maxIterations":5},"fixValidate":{"maxIterations":4,"enabled":false}}}' > "$TMPDIR_TEST/.ai-orchestrator.json"
  echo '{"phases":{"fixValidate":{"maxIterations":8}}}' > "$TMPDIR_TEST/.ai-orchestrator.local.json"
  _load_config_block
  [ "$MAX_REVIEW_FIX_ITERATIONS" = "5" ]   # from base (not overridden)
  [ "$MAX_FIX_VALIDATE_ITERATIONS" = "8" ]  # from override
  [ "$FIX_VALIDATE_ENABLED" = "false" ]     # from base (preserved within overridden object)
}

@test "local config malformed: wrapper exits 2 and names local path (fail-closed)" {
  setup_repo_root '.ai-orchestrator.json' '{"validation":{"commands":["a"]}}'
  echo "{not json" > "$REPO_ROOT/.ai-orchestrator.local.json"

  run load_layered_config "$REPO_ROOT"

  assert_failure 2
  assert_output --partial ".ai-orchestrator.local.json"
}

@test "no local config file: behavior unchanged" {
  echo '{"phases":{"reviewFix":{"maxIterations":6},"implement":{"maxIterations":5}}}' > "$TMPDIR_TEST/.ai-orchestrator.json"
  # No .ai-orchestrator.local.json created
  _load_config_block
  [ "$MAX_REVIEW_FIX_ITERATIONS" = "6" ]
  # _ACTIVE_CONFIG should equal _ORCHESTRATOR_CONFIG (no temp file created)
  [ "$_ACTIVE_CONFIG" = "$_ORCHESTRATOR_CONFIG" ]
}
