#!/usr/bin/env bats
setup() {
  SCRIPT_PATH="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/legacy/ai-run-issue-v2"
  eval "$(awk '
    /^_detect_loop_stall\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$SCRIPT_PATH")"
  TMPDIR_TEST="$(mktemp -d)"
  REVIEW_LOOP_HISTORY_FILE="$TMPDIR_TEST/review-loop-history.json"
}
teardown() {
  rm -rf "$TMPDIR_TEST"
}
@test "oscillation: first iteration returns STALL_NONE" {
  echo '[{"iteration":1,"spec_status":"SPEC_FAIL","quality_status":"QUALITY_FAIL","fix_status":"DONE","fix_diff_summary":"","spec_review_excerpt":"","quality_review_excerpt":""}]' > "$REVIEW_LOOP_HISTORY_FILE"
  _detect_loop_stall
  [ "$LOOP_STALL_TYPE" = "STALL_NONE" ]
}
@test "oscillation: alternating spec verdicts returns STALL_OSCILLATION" {
  cat > "$REVIEW_LOOP_HISTORY_FILE" << 'HIST'
[
  {"iteration":1,"spec_status":"SPEC_FAIL","quality_status":"QUALITY_FAIL","fix_status":"DONE","fix_diff_summary":"","spec_review_excerpt":"","quality_review_excerpt":""},
  {"iteration":2,"spec_status":"SPEC_PASS","quality_status":"QUALITY_PASS","fix_status":"DONE","fix_diff_summary":"","spec_review_excerpt":"","quality_review_excerpt":""},
  {"iteration":3,"spec_status":"SPEC_FAIL","quality_status":"QUALITY_FAIL","fix_status":"DONE","fix_diff_summary":"","spec_review_excerpt":"","quality_review_excerpt":""}
]
HIST
  _detect_loop_stall
  [ "$LOOP_STALL_TYPE" = "STALL_OSCILLATION" ]
}
@test "oscillation: alternating quality verdicts returns STALL_OSCILLATION" {
  cat > "$REVIEW_LOOP_HISTORY_FILE" << 'HIST'
[
  {"iteration":1,"spec_status":"SPEC_PASS","quality_status":"QUALITY_FAIL","fix_status":"DONE","fix_diff_summary":"","spec_review_excerpt":"","quality_review_excerpt":""},
  {"iteration":2,"spec_status":"SPEC_PASS","quality_status":"QUALITY_PASS","fix_status":"DONE","fix_diff_summary":"","spec_review_excerpt":"","quality_review_excerpt":""},
  {"iteration":3,"spec_status":"SPEC_PASS","quality_status":"QUALITY_FAIL","fix_status":"DONE","fix_diff_summary":"","spec_review_excerpt":"","quality_review_excerpt":""}
]
HIST
  _detect_loop_stall
  [ "$LOOP_STALL_TYPE" = "STALL_OSCILLATION" ]
}
@test "oscillation: same verdicts for 2+ iterations returns STALL_NO_PROGRESS" {
  cat > "$REVIEW_LOOP_HISTORY_FILE" << 'HIST'
[
  {"iteration":1,"spec_status":"SPEC_FAIL","quality_status":"QUALITY_FAIL","fix_status":"DONE","fix_diff_summary":"","spec_review_excerpt":"","quality_review_excerpt":""},
  {"iteration":2,"spec_status":"SPEC_FAIL","quality_status":"QUALITY_FAIL","fix_status":"DONE","fix_diff_summary":"","spec_review_excerpt":"","quality_review_excerpt":""},
  {"iteration":3,"spec_status":"SPEC_FAIL","quality_status":"QUALITY_FAIL","fix_status":"DONE","fix_diff_summary":"","spec_review_excerpt":"","quality_review_excerpt":""}
]
HIST
  _detect_loop_stall
  [ "$LOOP_STALL_TYPE" = "STALL_NO_PROGRESS" ]
}
@test "oscillation: converging verdicts returns STALL_NONE" {
  cat > "$REVIEW_LOOP_HISTORY_FILE" << 'HIST'
[
  {"iteration":1,"spec_status":"SPEC_FAIL","quality_status":"QUALITY_FAIL","fix_status":"DONE","fix_diff_summary":"","spec_review_excerpt":"","quality_review_excerpt":""},
  {"iteration":2,"spec_status":"SPEC_PASS","quality_status":"QUALITY_PASS","fix_status":"DONE","fix_diff_summary":"","spec_review_excerpt":"","quality_review_excerpt":""}
]
HIST
  _detect_loop_stall
  [ "$LOOP_STALL_TYPE" = "STALL_NONE" ]
}
@test "oscillation: empty history file returns STALL_NONE" {
  _detect_loop_stall
  [ "$LOOP_STALL_TYPE" = "STALL_NONE" ]
}
@test "oscillation: only fix_status alternating does not trigger oscillation" {
  cat > "$REVIEW_LOOP_HISTORY_FILE" << 'HIST'
[
  {"iteration":1,"spec_status":"SPEC_FAIL","quality_status":"QUALITY_FAIL","fix_status":"DONE","fix_diff_summary":"","spec_review_excerpt":"","quality_review_excerpt":""},
  {"iteration":2,"spec_status":"SPEC_FAIL","quality_status":"QUALITY_FAIL","fix_status":"DONE_NO_FIXES_NEEDED","fix_diff_summary":"","spec_review_excerpt":"","quality_review_excerpt":""}
]
HIST
  _detect_loop_stall
  [ "$LOOP_STALL_TYPE" = "STALL_NONE" ]
}

@test "review-fix loop: both-pass break precedes _detect_loop_stall (converged result wins)" {
  # Regression guard for the post-#169 ordering bug: a converged
  # SPEC_PASS/QUALITY_PASS must complete the task BEFORE stall detection runs,
  # otherwise an oscillating verdict history (e.g. quality PASS->FAIL->PASS)
  # sends a task that just succeeded to the arbiter. Assert the both-pass break
  # appears in the lines immediately preceding the _detect_loop_stall call.
  before="$(grep -B8 -E '^[[:space:]]+_detect_loop_stall$' "$SCRIPT_PATH")"
  echo "$before" | grep -qE 'SPEC_PASS.*&&.*QUALITY_PASS'
}
