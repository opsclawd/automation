#!/usr/bin/env bats
setup() {
  SCRIPT_PATH="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/ai-run-issue-v2"
  eval "$(awk '
    /^_append_loop_history\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$SCRIPT_PATH")"
  LOG_OUTPUT=""
  log() { LOG_OUTPUT="${LOG_OUTPUT}$*\n"; }
  TMPDIR_TEST="$(mktemp -d)"
  WORKTREE_DIR="$TMPDIR_TEST"
  REVIEW_LOOP_HISTORY_FILE="$TMPDIR_TEST/review-loop-history.json"
}
teardown() {
  rm -rf "$TMPDIR_TEST"
}
@test "history: first append creates valid JSON array with one entry" {
  _append_loop_history 1 "SPEC_FAIL" "QUALITY_FAIL" "DONE" "fix diff line" "spec review excerpt" "quality review excerpt"
  [ -f "$REVIEW_LOOP_HISTORY_FILE" ]
  run jq -e '. | length == 1' "$REVIEW_LOOP_HISTORY_FILE"
  [ "$status" -eq 0 ]
  run jq -r '.[0].iteration' "$REVIEW_LOOP_HISTORY_FILE"
  [ "$output" = "1" ]
  run jq -r '.[0].spec_status' "$REVIEW_LOOP_HISTORY_FILE"
  [ "$output" = "SPEC_FAIL" ]
  run jq -r '.[0].quality_status' "$REVIEW_LOOP_HISTORY_FILE"
  [ "$output" = "QUALITY_FAIL" ]
  run jq -r '.[0].fix_status' "$REVIEW_LOOP_HISTORY_FILE"
  [ "$output" = "DONE" ]
}
@test "history: second append adds entry to existing array" {
  _append_loop_history 1 "SPEC_FAIL" "QUALITY_FAIL" "DONE" "d1" "s1" "q1"
  _append_loop_history 2 "SPEC_PASS" "QUALITY_PASS" "DONE" "d2" "s2" "q2"
  run jq -e '. | length == 2' "$REVIEW_LOOP_HISTORY_FILE"
  [ "$status" -eq 0 ]
  run jq -r '.[1].iteration' "$REVIEW_LOOP_HISTORY_FILE"
  [ "$output" = "2" ]
}
@test "history: truncates long diff_summary to 20 lines" {
  local long_diff
  long_diff=$(printf 'line %d\n' {1..50})
  _append_loop_history 1 "SPEC_FAIL" "QUALITY_FAIL" "DONE" "$long_diff" "spec" "qual"
  local diff_lines
  diff_lines=$(jq -r '.[0].fix_diff_summary | split("\n") | length' "$REVIEW_LOOP_HISTORY_FILE")
  [ "$diff_lines" -le 20 ]
}
@test "history: truncates long review excerpts to 30 lines" {
  local long_review
  long_review=$(printf 'review line %d\n' {1..60})
  _append_loop_history 1 "SPEC_FAIL" "QUALITY_FAIL" "DONE" "diff" "$long_review" "$long_review"
  local spec_lines qual_lines
  spec_lines=$(jq -r '.[0].spec_review_excerpt | split("\n") | length' "$REVIEW_LOOP_HISTORY_FILE")
  qual_lines=$(jq -r '.[0].quality_review_excerpt | split("\n") | length' "$REVIEW_LOOP_HISTORY_FILE")
  [ "$spec_lines" -le 30 ]
  [ "$qual_lines" -le 30 ]
}
@test "history: handles missing review .md files gracefully" {
  _append_loop_history 1 "SPEC_FAIL" "QUALITY_FAIL" "DONE" "diff" "" ""
  [ -f "$REVIEW_LOOP_HISTORY_FILE" ]
  run jq -r '.[0].spec_review_excerpt' "$REVIEW_LOOP_HISTORY_FILE"
  [ "$output" = "" ]
}
