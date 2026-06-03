#!/usr/bin/env bats
# Tests for contradiction reconciliation in scripts/ai-run-issue-v2.
# When a review reports FAIL but fix-review returns DONE_NO_FIXES_NEEDED,
# the orchestrator should re-run the failing review once before aborting.
# See: scripts/ai-run-issue-v2 — review-fix loop (lines ~1438-1444)

setup() {
  SCRIPT_PATH="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/ai-run-issue-v2"
  SHARED_LIB="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/lib/result-resolver.sh"

  # Source shared helpers, then extract remaining functions via awk brace-counting
  # so tests exercise the actual script implementation.
  source "$SHARED_LIB"
  eval "$(awk '
    /^(resolve_result|validate_review_artifacts|rerun_reviewer_once|rerun_reviewer_for_contradiction|handle_contradiction_reconciliation)\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$SCRIPT_PATH")"

  # Stub dependencies
  LOG_OUTPUT=""
  log() { LOG_OUTPUT="${LOG_OUTPUT}$*\n"; }
  FAIL_OUTPUT=""
  orchestrator_fail() { FAIL_OUTPUT="$*"; return 1; }
  EMIT_EVENT_ARGS=""
  emit_event() { EMIT_EVENT_ARGS="$*"; }

  # Stub reviewers — track which ones were called
  SPEC_REVIEWER_RAN=0
  QUALITY_REVIEWER_RAN=0
  run_spec_reviewer() { SPEC_REVIEWER_RAN=1; }
  run_quality_reviewer() { QUALITY_REVIEWER_RAN=1; }

  TMPDIR_TEST="$(mktemp -d)"
  WORKTREE_DIR="$TMPDIR_TEST"
  ISSUES_DIR="$TMPDIR_TEST"
  REVIEW_LOOPS=0
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

@test "contradiction: QUALITY_FAIL + DONE_NO_FIXES_NEEDED triggers re-run of quality reviewer" {
  # Set up: quality review says FAIL, spec says PASS, fix-review says no fixes
  echo "SPEC_PASS" > "$TMPDIR_TEST/spec-review-task-1.result"
  touch "$TMPDIR_TEST/spec-review-task-1.md"
  echo "QUALITY_FAIL" > "$TMPDIR_TEST/quality-review-task-1.result"
  echo "quality findings" > "$TMPDIR_TEST/quality-review-task-1.md"
  echo "DONE_NO_FIXES_NEEDED" > "$TMPDIR_TEST/fix-review-task-1.result"
  touch "$TMPDIR_TEST/fix-review-task-1.md"

  CONTRADICTION_RETRIED=0
  handle_contradiction_reconciliation \
    "DONE_NO_FIXES_NEEDED" "SPEC_PASS" "QUALITY_FAIL" \
    "1" "test" "text" "" "" ""

  # Assertions: quality reviewer was re-run, spec was not
  [ "$CONTRADICTION_RETRIED" -eq 1 ]
  [ "$QUALITY_REVIEWER_RAN" -eq 1 ]
  [ "$SPEC_REVIEWER_RAN" -eq 0 ]
  [ "$CONTRADICTION_ACTION" = "retried" ]
}

@test "contradiction: both reviews FAIL triggers re-run of both reviewers" {
  echo "SPEC_FAIL" > "$TMPDIR_TEST/spec-review-task-1.result"
  echo "spec findings" > "$TMPDIR_TEST/spec-review-task-1.md"
  echo "QUALITY_FAIL" > "$TMPDIR_TEST/quality-review-task-1.result"
  echo "quality findings" > "$TMPDIR_TEST/quality-review-task-1.md"
  echo "DONE_NO_FIXES_NEEDED" > "$TMPDIR_TEST/fix-review-task-1.result"
  touch "$TMPDIR_TEST/fix-review-task-1.md"

  CONTRADICTION_RETRIED=0
  SPEC_REVIEWER_RAN=0
  QUALITY_REVIEWER_RAN=0

  handle_contradiction_reconciliation \
    "DONE_NO_FIXES_NEEDED" "SPEC_FAIL" "QUALITY_FAIL" \
    "1" "test" "text" "" "" ""

  [ "$CONTRADICTION_RETRIED" -eq 1 ]
  [ "$SPEC_REVIEWER_RAN" -eq 1 ]
  [ "$QUALITY_REVIEWER_RAN" -eq 1 ]
  [ "$CONTRADICTION_ACTION" = "retried" ]
}

@test "contradiction retry exhausted: second contradiction fails with already_retried" {
  echo "SPEC_FAIL" > "$TMPDIR_TEST/spec-review-task-1.result"
  echo "spec findings" > "$TMPDIR_TEST/spec-review-task-1.md"
  echo "QUALITY_PASS" > "$TMPDIR_TEST/quality-review-task-1.result"
  touch "$TMPDIR_TEST/quality-review-task-1.md"
  echo "DONE_NO_FIXES_NEEDED" > "$TMPDIR_TEST/fix-review-task-1.result"
  touch "$TMPDIR_TEST/fix-review-task-1.md"

  # Simulate retry already consumed
  CONTRADICTION_RETRIED=1

  handle_contradiction_reconciliation \
    "DONE_NO_FIXES_NEEDED" "SPEC_FAIL" "QUALITY_PASS" \
    "1" "test" "text" "" "" ""

  [ "$CONTRADICTION_ACTION" = "already_retried" ]
  [ "$SPEC_REVIEWER_RAN" -eq 0 ]
  [ "$QUALITY_REVIEWER_RAN" -eq 0 ]
}

@test "no contradiction: both reviews PASS skips retry entirely" {
  echo "SPEC_PASS" > "$TMPDIR_TEST/spec-review-task-1.result"
  touch "$TMPDIR_TEST/spec-review-task-1.md"
  echo "QUALITY_PASS" > "$TMPDIR_TEST/quality-review-task-1.result"
  touch "$TMPDIR_TEST/quality-review-task-1.md"
  echo "DONE_NO_FIXES_NEEDED" > "$TMPDIR_TEST/fix-review-task-1.result"
  touch "$TMPDIR_TEST/fix-review-task-1.md"

  CONTRADICTION_RETRIED=0

  handle_contradiction_reconciliation \
    "DONE_NO_FIXES_NEEDED" "SPEC_PASS" "QUALITY_PASS" \
    "1" "test" "text" "" "" ""

  [ "$CONTRADICTION_ACTION" = "none" ]
  [ "$CONTRADICTION_RETRIED" -eq 0 ]
  [ "$SPEC_REVIEWER_RAN" -eq 0 ]
  [ "$QUALITY_REVIEWER_RAN" -eq 0 ]
}

@test "contradiction: post-retry resolve_result re-check — re-run resolves to PASS" {
  # Set up initial FAIL results
  echo "SPEC_PASS" > "$TMPDIR_TEST/spec-review-task-1.result"
  touch "$TMPDIR_TEST/spec-review-task-1.md"
  echo "QUALITY_FAIL" > "$TMPDIR_TEST/quality-review-task-1.result"
  echo "quality findings" > "$TMPDIR_TEST/quality-review-task-1.md"
  echo "DONE_NO_FIXES_NEEDED" > "$TMPDIR_TEST/fix-review-task-1.result"
  touch "$TMPDIR_TEST/fix-review-task-1.md"

  # Override rerun_reviewer_for_contradiction to simulate a successful re-run
  # that overwrites the result files with PASS values.
  rerun_reviewer_for_contradiction() {
    local reviewer_type="$1"
    if [[ "$reviewer_type" == "spec" ]]; then
      echo "SPEC_PASS" > "$TMPDIR_TEST/spec-review-task-1.result"
      echo "spec re-run findings" > "$TMPDIR_TEST/spec-review-task-1.md"
    fi
    if [[ "$reviewer_type" == "quality" ]]; then
      echo "QUALITY_PASS" > "$TMPDIR_TEST/quality-review-task-1.result"
      echo "quality re-run findings" > "$TMPDIR_TEST/quality-review-task-1.md"
    fi
    QUALITY_REVIEWER_RAN=1
  }

  CONTRADICTION_RETRIED=0

  handle_contradiction_reconciliation \
    "DONE_NO_FIXES_NEEDED" "SPEC_FAIL" "QUALITY_FAIL" \
    "1" "test" "text" "" "" ""

  # Post-retry re-check should find both passing
  [ "$CONTRADICTION_ACTION" = "resolved" ]
  [ "$SPEC_STATUS" = "SPEC_PASS" ]
  [ "$QUALITY_STATUS" = "QUALITY_PASS" ]
  [ "$QUALITY_REVIEWER_RAN" -eq 1 ]
}

@test "contradiction: emit_event includes iteration field" {
  echo "SPEC_FAIL" > "$TMPDIR_TEST/spec-review-task-1.result"
  echo "spec findings" > "$TMPDIR_TEST/spec-review-task-1.md"
  echo "QUALITY_PASS" > "$TMPDIR_TEST/quality-review-task-1.result"
  touch "$TMPDIR_TEST/quality-review-task-1.md"
  echo "DONE_NO_FIXES_NEEDED" > "$TMPDIR_TEST/fix-review-task-1.result"
  touch "$TMPDIR_TEST/fix-review-task-1.md"

  CONTRADICTION_RETRIED=0
  REVIEW_LOOPS=2

  handle_contradiction_reconciliation \
    "DONE_NO_FIXES_NEEDED" "SPEC_FAIL" "QUALITY_PASS" \
    "1" "test" "text" "" "" ""

  # Verify emit_event was called with iteration field
  [[ "$EMIT_EVENT_ARGS" == *"iteration=2"* ]]
}
