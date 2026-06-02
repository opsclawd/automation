#!/usr/bin/env bats

setup() {
  SCRIPT_PATH="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/ai-run-issue-v2"
  eval "$(awk '
    /^validate_review_artifacts\(\)/ { state=1; depth=0 }
    /^is_task_complete\(\)/ { state=2; depth=0 }
    state {
      print
      if (/\{/) depth+=gsub(/{/,"{")
      if (/\}/) depth-=gsub(/}/,"}")
      if (depth==0) {
        if (state == 2) exit
        state=0
      }
    }
  ' "$SCRIPT_PATH")"
  TMPDIR_TEST="$(mktemp -d)"
  export ISSUES_DIR="$TMPDIR_TEST"
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

@test "is_task_complete: no impl result → pending, exit 1" {
  run is_task_complete 1
  [ "$status" -eq 1 ]
  [ "$output" = "pending" ]
}

@test "is_task_complete: impl started (log exists) but no success result → implementing, exit 1" {
  touch "${ISSUES_DIR}/implement-task-1.log"
  run is_task_complete 1
  [ "$status" -eq 1 ]
  [ "$output" = "implementing" ]
}

@test "is_task_complete: impl DONE but no review results → review-needed, exit 1" {
  echo "DONE" > "${ISSUES_DIR}/implement-task-1.result"
  run is_task_complete 1
  [ "$status" -eq 1 ]
  [ "$output" = "review-needed" ]
}

@test "is_task_complete: impl DONE_WITH_CONCERNS but no review results → review-needed, exit 1" {
  echo "DONE_WITH_CONCERNS" > "${ISSUES_DIR}/implement-task-1.result"
  run is_task_complete 1
  [ "$status" -eq 1 ]
  [ "$output" = "review-needed" ]
}

@test "is_task_complete: reviews pass → complete, exit 0" {
  echo "DONE" > "${ISSUES_DIR}/implement-task-1.result"
  echo "SPEC_PASS" > "${ISSUES_DIR}/spec-review-task-1.result"
  echo "QUALITY_PASS" > "${ISSUES_DIR}/quality-review-task-1.result"
  echo "Spec review report" > "${ISSUES_DIR}/spec-review-task-1.md"
  echo "Quality review report" > "${ISSUES_DIR}/quality-review-task-1.md"
  run is_task_complete 1
  [ "$status" -eq 0 ]
  [ "$output" = "complete" ]
}

@test "is_task_complete: spec fail, no deviation → review-needed, exit 1" {
  echo "DONE" > "${ISSUES_DIR}/implement-task-1.result"
  echo "SPEC_FAIL" > "${ISSUES_DIR}/spec-review-task-1.result"
  echo "QUALITY_PASS" > "${ISSUES_DIR}/quality-review-task-1.result"
  echo "Spec report" > "${ISSUES_DIR}/spec-review-task-1.md"
  echo "Quality report" > "${ISSUES_DIR}/quality-review-task-1.md"
  run is_task_complete 1
  [ "$status" -eq 1 ]
  [ "$output" = "review-needed" ]
}

@test "is_task_complete: reviews fail but DEVIATION_PROCEED → complete, exit 0" {
  echo "DONE" > "${ISSUES_DIR}/implement-task-1.result"
  echo "SPEC_FAIL" > "${ISSUES_DIR}/spec-review-task-1.result"
  echo "QUALITY_FAIL" > "${ISSUES_DIR}/quality-review-task-1.result"
  echo "Spec report" > "${ISSUES_DIR}/spec-review-task-1.md"
  echo "Quality report" > "${ISSUES_DIR}/quality-review-task-1.md"
  echo '{"outcome":"DEVIATION_PROCEED"}' > "${ISSUES_DIR}/deviation-record-1.json"
  run is_task_complete 1
  [ "$status" -eq 0 ]
  [ "$output" = "complete" ]
}

@test "is_task_complete: reviews fail but RESOLVED_TIEBREAK → complete, exit 0" {
  echo "DONE" > "${ISSUES_DIR}/implement-task-1.result"
  echo "SPEC_FAIL" > "${ISSUES_DIR}/spec-review-task-1.result"
  echo "QUALITY_FAIL" > "${ISSUES_DIR}/quality-review-task-1.result"
  echo "Spec report" > "${ISSUES_DIR}/spec-review-task-1.md"
  echo "Quality report" > "${ISSUES_DIR}/quality-review-task-1.md"
  echo '{"outcome":"RESOLVED_TIEBREAK"}' > "${ISSUES_DIR}/deviation-record-1.json"
  run is_task_complete 1
  [ "$status" -eq 0 ]
  [ "$output" = "complete" ]
}

@test "is_task_complete: reviews fail with BLOCKED_IMPL_DEFECT → review-needed, exit 1" {
  echo "DONE" > "${ISSUES_DIR}/implement-task-1.result"
  echo "SPEC_FAIL" > "${ISSUES_DIR}/spec-review-task-1.result"
  echo "QUALITY_FAIL" > "${ISSUES_DIR}/quality-review-task-1.result"
  echo "Spec report" > "${ISSUES_DIR}/spec-review-task-1.md"
  echo "Quality report" > "${ISSUES_DIR}/quality-review-task-1.md"
  echo '{"outcome":"BLOCKED_IMPL_DEFECT"}' > "${ISSUES_DIR}/deviation-record-1.json"
  run is_task_complete 1
  [ "$status" -eq 1 ]
  [ "$output" = "review-needed" ]
}

@test "is_task_complete: review result exists but .md empty → review-needed, exit 1" {
  echo "DONE" > "${ISSUES_DIR}/implement-task-1.result"
  echo "SPEC_PASS" > "${ISSUES_DIR}/spec-review-task-1.result"
  echo "QUALITY_PASS" > "${ISSUES_DIR}/quality-review-task-1.result"
  touch "${ISSUES_DIR}/spec-review-task-1.md"
  echo "Quality report" > "${ISSUES_DIR}/quality-review-task-1.md"
  run is_task_complete 1
  [ "$status" -eq 1 ]
  [ "$output" = "review-needed" ]
}
