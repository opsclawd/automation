#!/usr/bin/env bats

# Tests for detect_phase resume detection with the fix-validate phase.

setup() {
  TMPDIR_TEST="$(mktemp -d)"
  REPO_ROOT="$TMPDIR_TEST"
  WORKTREE_DIR="$TMPDIR_TEST"
  ISSUES_DIR="$TMPDIR_TEST"
  # Stub helpers not needed for detect_phase
  detect_resume_point() { echo "implement"; }
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

# Extract detect_phase from the script
_load_detect_phase() {
  SCRIPT_PATH="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/ai-run-issue-v2"
  eval "$(sed -n '/^detect_phase()/,/^}/p' "$SCRIPT_PATH")"
}

@test "detect_phase: validation.result=passed goes to whole-pr-review" {
  echo "passed" > "${ISSUES_DIR}/validation.result"
  _load_detect_phase
  run detect_phase
  [ "$output" = "whole-pr-review" ]
}

@test "detect_phase: validation.result=failed without marker goes to fix-validate" {
  echo "failed" > "${ISSUES_DIR}/validation.result"
  _load_detect_phase
  run detect_phase
  [ "$output" = "fix-validate" ]
}

@test "detect_phase: validation.result=failed with marker goes to whole-pr-review" {
  echo "failed" > "${ISSUES_DIR}/validation.result"
  touch "${ISSUES_DIR}/fix-validate-done.marker"
  _load_detect_phase
  run detect_phase
  [ "$output" = "whole-pr-review" ]
}

@test "detect_phase: validation.result=unresolved-review with marker goes to whole-pr-review" {
  echo "unresolved-review" > "${ISSUES_DIR}/validation.result"
  touch "${ISSUES_DIR}/fix-validate-done.marker"
  _load_detect_phase
  run detect_phase
  [ "$output" = "whole-pr-review" ]
}

@test "detect_phase: validation.result=unresolved-review without marker goes to fix-validate" {
  echo "unresolved-review" > "${ISSUES_DIR}/validation.result"
  _load_detect_phase
  run detect_phase
  [ "$output" = "fix-validate" ]
}

@test "detect_phase: ORCHESTRATOR_PHASE env var overrides sentinel detection" {
  echo "failed" > "${ISSUES_DIR}/validation.result"
  _load_detect_phase
  ORCHESTRATOR_PHASE="custom-phase" run detect_phase
  [ "$output" = "custom-phase" ]
}
