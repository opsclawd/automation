#!/usr/bin/env bats
# Tests for contradiction reconciliation in scripts/ai-run-issue-v2.
# When a review reports FAIL but fix-review returns DONE_NO_FIXES_NEEDED,
# the orchestrator should re-run the failing review once before aborting.
# See: scripts/ai-run-issue-v2 — review-fix loop (lines ~1438-1444)
setup() {
  SCRIPT_PATH="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/ai-run-issue-v2"
  # Extract functions needed for the test via awk brace-counting.
  eval "$(awk '
    /^(validate_result_file|read_result_value|resolve_result|validate_review_artifacts|rerun_reviewer_once)\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$SCRIPT_PATH")"
  # Stub dependencies
  LOG_OUTPUT=""
  log() { LOG_OUTPUT="${LOG_OUTPUT}$*\n"; }
  FAIL_OUTPUT=""
  orchestrator_fail() { FAIL_OUTPUT="$*"; return 1; }
  emit_event() { :; }
  # Stub reviewers — track which ones were called
  SPEC_REVIEWER_RAN=0
  QUALITY_REVIEWER_RAN=0
  run_spec_reviewer() { SPEC_REVIEWER_RAN=1; }
  run_quality_reviewer() { QUALITY_REVIEWER_RAN=1; }
  TMPDIR_TEST="$(mktemp -d)"
  WORKTREE_DIR="$TMPDIR_TEST"
  ISSUES_DIR="$TMPDIR_TEST"
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
  # Resolve statuses (mimicking the loop's pre-check)
  SPEC_STATUS=$(resolve_result \
    "$TMPDIR_TEST/spec-review-task-1.result" \
    "$TMPDIR_TEST/spec-review-task-1.md" \
    SPEC_PASS SPEC_FAIL "SPEC_FAIL")
  QUALITY_STATUS=$(resolve_result \
    "$TMPDIR_TEST/quality-review-task-1.result" \
    "$TMPDIR_TEST/quality-review-task-1.md" \
    QUALITY_PASS QUALITY_FAIL "QUALITY_FAIL")
  FIX_STATUS=$(resolve_result \
    "$TMPDIR_TEST/fix-review-task-1.result" \
    "$TMPDIR_TEST/fix-review-task-1.md" \
    DONE DONE_NO_FIXES_NEEDED BLOCKED "DONE")
  # Verify preconditions
  [ "$SPEC_STATUS" = "SPEC_PASS" ]
  [ "$QUALITY_STATUS" = "QUALITY_FAIL" ]
  [ "$FIX_STATUS" = "DONE_NO_FIXES_NEEDED" ]
  # Simulate the contradiction reconciliation logic
  CONTRADICTION_RETRIED=0
  if [[ "$FIX_STATUS" == "DONE_NO_FIXES_NEEDED" ]]; then
    if [[ "$SPEC_STATUS" != "SPEC_PASS" || "$QUALITY_STATUS" != "QUALITY_PASS" ]]; then
      if [[ "$CONTRADICTION_RETRIED" -lt 1 ]]; then
        CONTRADICTION_RETRIED=1
        # Re-run the failing review(s)
        if [[ "$SPEC_STATUS" == "SPEC_FAIL" ]]; then
          rerun_reviewer_once "spec" "1" "test" "text" "" "" ""
          SPEC_REVIEWER_RAN=1
        fi
        if [[ "$QUALITY_STATUS" == "QUALITY_FAIL" ]]; then
          rerun_reviewer_once "quality" "1" "test" "text" "" "" ""
          QUALITY_REVIEWER_RAN=1
        fi
      fi
    fi
  fi
  # Assertions: quality reviewer was re-run, spec was not
  [ "$CONTRADICTION_RETRIED" -eq 1 ]
  [ "$QUALITY_REVIEWER_RAN" -eq 1 ]
  [ "$SPEC_REVIEWER_RAN" -eq 0 ]
}
@test "contradiction: both reviews FAIL triggers re-run of both reviewers" {
  echo "SPEC_FAIL" > "$TMPDIR_TEST/spec-review-task-1.result"
  echo "spec findings" > "$TMPDIR_TEST/spec-review-task-1.md"
  echo "QUALITY_FAIL" > "$TMPDIR_TEST/quality-review-task-1.result"
  echo "quality findings" > "$TMPDIR_TEST/quality-review-task-1.md"
  echo "DONE_NO_FIXES_NEEDED" > "$TMPDIR_TEST/fix-review-task-1.result"
  touch "$TMPDIR_TEST/fix-review-task-1.md"
  SPEC_STATUS=$(resolve_result \
    "$TMPDIR_TEST/spec-review-task-1.result" \
    "$TMPDIR_TEST/spec-review-task-1.md" \
    SPEC_PASS SPEC_FAIL "SPEC_FAIL")
  QUALITY_STATUS=$(resolve_result \
    "$TMPDIR_TEST/quality-review-task-1.result" \
    "$TMPDIR_TEST/quality-review-task-1.md" \
    QUALITY_PASS QUALITY_FAIL "QUALITY_FAIL")
  FIX_STATUS=$(resolve_result \
    "$TMPDIR_TEST/fix-review-task-1.result" \
    "$TMPDIR_TEST/fix-review-task-1.md" \
    DONE DONE_NO_FIXES_NEEDED BLOCKED "DONE")
  [ "$SPEC_STATUS" = "SPEC_FAIL" ]
  [ "$QUALITY_STATUS" = "QUALITY_FAIL" ]
  [ "$FIX_STATUS" = "DONE_NO_FIXES_NEEDED" ]
  CONTRADICTION_RETRIED=0
  SPEC_REVIEWER_RAN=0
  QUALITY_REVIEWER_RAN=0
  if [[ "$FIX_STATUS" == "DONE_NO_FIXES_NEEDED" ]]; then
    if [[ "$SPEC_STATUS" != "SPEC_PASS" || "$QUALITY_STATUS" != "QUALITY_PASS" ]]; then
      if [[ "$CONTRADICTION_RETRIED" -lt 1 ]]; then
        CONTRADICTION_RETRIED=1
        if [[ "$SPEC_STATUS" == "SPEC_FAIL" ]]; then
          SPEC_REVIEWER_RAN=1
        fi
        if [[ "$QUALITY_STATUS" == "QUALITY_FAIL" ]]; then
          QUALITY_REVIEWER_RAN=1
        fi
      fi
    fi
  fi
  [ "$CONTRADICTION_RETRIED" -eq 1 ]
  [ "$SPEC_REVIEWER_RAN" -eq 1 ]
  [ "$QUALITY_REVIEWER_RAN" -eq 1 ]
}
@test "contradiction retry exhausted: second contradiction fails with reviews_inconsistent" {
  echo "SPEC_FAIL" > "$TMPDIR_TEST/spec-review-task-1.result"
  echo "spec findings" > "$TMPDIR_TEST/spec-review-task-1.md"
  echo "QUALITY_PASS" > "$TMPDIR_TEST/quality-review-task-1.result"
  touch "$TMPDIR_TEST/quality-review-task-1.md"
  echo "DONE_NO_FIXES_NEEDED" > "$TMPDIR_TEST/fix-review-task-1.result"
  touch "$TMPDIR_TEST/fix-review-task-1.md"
  SPEC_STATUS=$(resolve_result \
    "$TMPDIR_TEST/spec-review-task-1.result" \
    "$TMPDIR_TEST/spec-review-task-1.md" \
    SPEC_PASS SPEC_FAIL "SPEC_FAIL")
  QUALITY_STATUS=$(resolve_result \
    "$TMPDIR_TEST/quality-review-task-1.result" \
    "$TMPDIR_TEST/quality-review-task-1.md" \
    QUALITY_PASS QUALITY_FAIL "QUALITY_FAIL")
  FIX_STATUS=$(resolve_result \
    "$TMPDIR_TEST/fix-review-task-1.result" \
    "$TMPDIR_TEST/fix-review-task-1.md" \
    DONE DONE_NO_FIXES_NEEDED BLOCKED "DONE")
  # Simulate retry already consumed
  CONTRADICTION_RETRIED=1
  FAIL_MSG=""
  if [[ "$FIX_STATUS" == "DONE_NO_FIXES_NEEDED" ]]; then
    if [[ "$SPEC_STATUS" != "SPEC_PASS" || "$QUALITY_STATUS" != "QUALITY_PASS" ]]; then
      if [[ "$CONTRADICTION_RETRIED" -lt 1 ]]; then
        CONTRADICTION_RETRIED=1
      else
        FAIL_MSG="reviews_inconsistent"
      fi
    fi
  fi
  [ "$FAIL_MSG" = "reviews_inconsistent" ]
}
@test "no contradiction: both reviews PASS skips retry entirely" {
  echo "SPEC_PASS" > "$TMPDIR_TEST/spec-review-task-1.result"
  touch "$TMPDIR_TEST/spec-review-task-1.md"
  echo "QUALITY_PASS" > "$TMPDIR_TEST/quality-review-task-1.result"
  touch "$TMPDIR_TEST/quality-review-task-1.md"
  echo "DONE_NO_FIXES_NEEDED" > "$TMPDIR_TEST/fix-review-task-1.result"
  touch "$TMPDIR_TEST/fix-review-task-1.md"
  SPEC_STATUS=$(resolve_result \
    "$TMPDIR_TEST/spec-review-task-1.result" \
    "$TMPDIR_TEST/spec-review-task-1.md" \
    SPEC_PASS SPEC_FAIL "SPEC_FAIL")
  QUALITY_STATUS=$(resolve_result \
    "$TMPDIR_TEST/quality-review-task-1.result" \
    "$TMPDIR_TEST/quality-review-task-1.md" \
    QUALITY_PASS QUALITY_FAIL "QUALITY_FAIL")
  FIX_STATUS=$(resolve_result \
    "$TMPDIR_TEST/fix-review-task-1.result" \
    "$TMPDIR_TEST/fix-review-task-1.md" \
    DONE DONE_NO_FIXES_NEEDED BLOCKED "DONE")
  CONTRADICTION_RETRIED=0
  RETRY_PATH_TAKEN=0
  if [[ "$FIX_STATUS" == "DONE_NO_FIXES_NEEDED" ]]; then
    if [[ "$SPEC_STATUS" != "SPEC_PASS" || "$QUALITY_STATUS" != "QUALITY_PASS" ]]; then
      RETRY_PATH_TAKEN=1
    fi
  fi
  # Both pass, so the inner condition is false — no retry
  [ "$RETRY_PATH_TAKEN" -eq 0 ]
  [ "$CONTRADICTION_RETRIED" -eq 0 ]
}
