#!/usr/bin/env bats
# Tests for review-contract.sh — validate_review_verdict, build_corrective_warning,
# recover_off_contract_review_artifacts (#305).
# See: scripts/lib/review-contract.sh

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  source "${REPO_ROOT}/scripts/lib/review-contract.sh"
  LOG_OUTPUT=""
  log() { LOG_OUTPUT="${LOG_OUTPUT}$*\n"; }
  TMPDIR_TEST="$(mktemp -d)"
  WORKTREE_DIR="$TMPDIR_TEST"
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

# ── validate_review_verdict ──────────────────────────────────────────────

@test "validate_review_verdict: valid verdict returns 0" {
  echo "SPEC_PASS" > "$TMPDIR_TEST/test.result"
  run validate_review_verdict "$TMPDIR_TEST/test.result" SPEC_PASS SPEC_FAIL
  [ "$status" -eq 0 ]
}

@test "validate_review_verdict: invalid verdict returns 2" {
  echo "SPEC_PARTIAL" > "$TMPDIR_TEST/test.result"
  run validate_review_verdict "$TMPDIR_TEST/test.result" SPEC_PASS SPEC_FAIL
  [ "$status" -eq 2 ]
}

@test "validate_review_verdict: QUALITY_FAIL is valid for quality allowed set" {
  echo "QUALITY_FAIL" > "$TMPDIR_TEST/test.result"
  run validate_review_verdict "$TMPDIR_TEST/test.result" QUALITY_PASS QUALITY_FAIL
  [ "$status" -eq 0 ]
}

@test "validate_review_verdict: quality value rejected by spec allowed set returns 2" {
  echo "QUALITY_PASS" > "$TMPDIR_TEST/test.result"
  run validate_review_verdict "$TMPDIR_TEST/test.result" SPEC_PASS SPEC_FAIL
  [ "$status" -eq 2 ]
}

@test "validate_review_verdict: missing file returns 1" {
  run validate_review_verdict "$TMPDIR_TEST/missing.result" SPEC_PASS SPEC_FAIL
  [ "$status" -eq 1 ]
}

@test "validate_review_verdict: empty file returns 2" {
  touch "$TMPDIR_TEST/test.result"
  run validate_review_verdict "$TMPDIR_TEST/test.result" SPEC_PASS SPEC_FAIL
  [ "$status" -eq 2 ]
}

@test "validate_review_verdict: case-sensitive match (uppercase only)" {
  echo "spec_pass" > "$TMPDIR_TEST/test.result"
  run validate_review_verdict "$TMPDIR_TEST/test.result" SPEC_PASS SPEC_FAIL
  [ "$status" -eq 2 ]
}

@test "validate_review_verdict: prose in file returns 2" {
  echo "The verdict is SPEC_PASS" > "$TMPDIR_TEST/test.result"
  run validate_review_verdict "$TMPDIR_TEST/test.result" SPEC_PASS SPEC_FAIL
  [ "$status" -eq 2 ]
}

# ── build_corrective_warning ─────────────────────────────────────────────

@test "build_corrective_warning: wrong_path produces path-specific message" {
  run build_corrective_warning "spec" "3" "wrong_path" "" "/tmp/worktree/docs/TASK-3.result"
  [[ "$output" == *"wrong location"* ]]
  [[ "$output" == *"/tmp/worktree/docs/TASK-3.result"* ]]
}

@test "build_corrective_warning: invalid_verdict names the actual verdict" {
  run build_corrective_warning "quality" "2" "invalid_verdict" "QUALITY_PARTIAL" ""
  [[ "$output" == *"'QUALITY_PARTIAL'"* ]]
  [[ "$output" == *"NOT an allowed value"* ]]
}

@test "build_corrective_warning: missing_artifacts describes ordering rule" {
  run build_corrective_warning "spec" "1" "missing_artifacts" "" ""
  [[ "$output" == *"write BOTH files in order"* ]]
  [[ "$output" == *".md first, then .result last"* ]]
}

# ── recover_off_contract_review_artifacts ────────────────────────────────

@test "recover_off_contract_review_artifacts: returns 0 when artifacts already at expected paths" {
  echo "SPEC_PASS" > "$TMPDIR_TEST/spec-review-task-1.result"
  echo "findings" > "$TMPDIR_TEST/spec-review-task-1.md"
  run recover_off_contract_review_artifacts "spec" "1"
  [ "$status" -eq 0 ]
}

@test "recover_off_contract_review_artifacts: returns 1 when nothing found anywhere" {
  run recover_off_contract_review_artifacts "spec" "1"
  [ "$status" -eq 1 ]
}

@test "recover_off_contract_review_artifacts: recovers .result from docs/ subdirectory" {
  mkdir -p "$TMPDIR_TEST/docs"
  echo "SPEC_FAIL" > "$TMPDIR_TEST/docs/TASK-1.result"
  echo "findings" > "$TMPDIR_TEST/docs/TASK-1.md"
  run recover_off_contract_review_artifacts "spec" "1"
  [ "$status" -eq 0 ]
  [ -f "$TMPDIR_TEST/spec-review-task-1.result" ]
  [ -f "$TMPDIR_TEST/spec-review-task-1.md" ]
  [ "$(cat "$TMPDIR_TEST/spec-review-task-1.result")" = "SPEC_FAIL" ]
}

@test "recover_off_contract_review_artifacts: recovers from docs/spec-vs-implementation-reviews/" {
  mkdir -p "$TMPDIR_TEST/docs/spec-vs-implementation-reviews"
  echo "SPEC_PASS" > "$TMPDIR_TEST/docs/spec-vs-implementation-reviews/TASK-3.result"
  echo "No findings." > "$TMPDIR_TEST/docs/spec-vs-implementation-reviews/TASK-3-spec-vs-implementation.md"
  run recover_off_contract_review_artifacts "spec" "3"
  [ "$status" -eq 0 ]
  [ -f "$TMPDIR_TEST/spec-review-task-3.result" ]
}

@test "recover_off_contract_review_artifacts: does not overwrite existing expected file" {
  mkdir -p "$TMPDIR_TEST/docs"
  echo "original" > "$TMPDIR_TEST/spec-review-task-2.result"
  echo "SPEC_PASS" > "$TMPDIR_TEST/docs/TASK-2.result"
  run recover_off_contract_review_artifacts "spec" "2"
  [ "$status" -eq 0 ]
  [ "$(cat "$TMPDIR_TEST/spec-review-task-2.result")" = "original" ]
}

@test "recover_off_contract_review_artifacts: returns 0 with partial recovery (.result only)" {
  mkdir -p "$TMPDIR_TEST/docs"
  echo "QUALITY_FAIL" > "$TMPDIR_TEST/docs/TASK-1.result"
  run recover_off_contract_review_artifacts "quality" "1"
  [ "$status" -eq 0 ]
  [ -f "$TMPDIR_TEST/quality-review-task-1.result" ]
  [ ! -f "$TMPDIR_TEST/quality-review-task-1.md" ]
}