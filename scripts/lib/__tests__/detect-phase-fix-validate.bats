#!/usr/bin/env bats

# Tests for detect_phase resume detection with the fix-validate phase.

setup() {
  TMPDIR_TEST="$(mktemp -d)"
  REPO_ROOT="$TMPDIR_TEST"
  WORKTREE_DIR="$TMPDIR_TEST"
  ISSUES_DIR="$TMPDIR_TEST"
  # Stub helpers not needed for detect_phase
  detect_resume_point() { echo "implement"; }
  # Git stub: ignores all args (-C, rev-parse, etc.), echoes controlled SHA
  git() { echo "${_STUB_HEAD_SHA:-abc123}"; }
  export -f git
  # Source the library directly — no fragile sed extraction needed
  source "$(cd "$BATS_TEST_DIRNAME/.." && pwd)/detect-phase.sh"
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

@test "detect_phase: validation.result=passed goes to whole-pr-review" {
  echo "passed" > "${ISSUES_DIR}/validation.result"
  echo "abc123" > "${ISSUES_DIR}/validation.headsha"
  _STUB_HEAD_SHA=abc123 run detect_phase
  [ "$output" = "whole-pr-review" ]
}

@test "detect_phase: validation.result=failed without marker goes to fix-validate" {
  echo "failed" > "${ISSUES_DIR}/validation.result"
  run detect_phase
  [ "$output" = "fix-validate" ]
}

@test "detect_phase: validation.result=failed with marker goes to whole-pr-review" {
  echo "failed" > "${ISSUES_DIR}/validation.result"
  touch "${ISSUES_DIR}/fix-validate-done.marker"
  echo "abc123" > "${ISSUES_DIR}/validation.headsha"
  _STUB_HEAD_SHA=abc123 run detect_phase
  [ "$output" = "whole-pr-review" ]
}

@test "detect_phase: validation.result=unresolved-review with marker goes to whole-pr-review" {
  echo "unresolved-review" > "${ISSUES_DIR}/validation.result"
  touch "${ISSUES_DIR}/fix-validate-done.marker"
  echo "abc123" > "${ISSUES_DIR}/validation.headsha"
  _STUB_HEAD_SHA=abc123 run detect_phase
  [ "$output" = "whole-pr-review" ]
}

@test "detect_phase: validation.result=unresolved-review without marker goes to fix-validate" {
  echo "unresolved-review" > "${ISSUES_DIR}/validation.result"
  run detect_phase
  [ "$output" = "fix-validate" ]
}

@test "detect_phase: ORCHESTRATOR_PHASE env var overrides sentinel detection" {
  echo "failed" > "${ISSUES_DIR}/validation.result"
  ORCHESTRATOR_PHASE="custom-phase" run detect_phase
  [ "$output" = "custom-phase" ]
}

@test "detect_phase: validation.result=passed with matching SHA stays on whole-pr-review" {
  echo "passed" > "${ISSUES_DIR}/validation.result"
  echo "abc123" > "${ISSUES_DIR}/validation.headsha"
  _STUB_HEAD_SHA=abc123 run detect_phase
  [ "$output" = "whole-pr-review" ]
}

@test "detect_phase: validation.result=passed with mismatched SHA goes to validate" {
  echo "passed" > "${ISSUES_DIR}/validation.result"
  echo "abc123" > "${ISSUES_DIR}/validation.headsha"
  _STUB_HEAD_SHA=def456 run detect_phase
  [ "$output" = "validate" ]
}

@test "detect_phase: validation.result=passed without headsha file goes to validate" {
  echo "passed" > "${ISSUES_DIR}/validation.result"
  run detect_phase
  [ "$output" = "validate" ]
}

@test "ai-run-issue-v2 sources detect-phase.sh" {
  REAL_REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  run grep -q 'source.*detect-phase.sh' "${REAL_REPO_ROOT}/scripts/ai-run-issue-v2"
  [[ "$status" -eq 0 ]]
}
