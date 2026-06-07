#!/usr/bin/env bats

# Tests for phase iteration limit config reading in ai-run-issue-v2.
# We extract the config-reading block via awk and test it in isolation.

setup() {
  TMPDIR_TEST="$(mktemp -d)"
  REPO_ROOT="$TMPDIR_TEST"
  LOG_OUTPUT=""
  # Stub log to capture output
  log() { LOG_OUTPUT="${LOG_OUTPUT}$*\n"; }
  # Stub mkdir — the config-reading block ensures ISSUES_DIR exists before
  # the first log() call so tee -a doesn't fail under set -euo pipefail.
  # Tests evaluate that block in isolation, so we no-op the side effect.
  mkdir() { :; }
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

# Extract the config-reading block from the script.
# The block starts at the "# ── Phase iteration limits" comment and ends
# at the log line that follows the fi.
_load_config_block() {
  SCRIPT_PATH="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/ai-run-issue-v2"
  eval "$(awk '
    /# ── Phase iteration limits from config/ { found=1 }
    found {
      print
      if (/^log "Config:/) { found=0 }
    }
  ' "$SCRIPT_PATH")"
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
