#!/usr/bin/env bats

setup() {
  TMPDIR_TEST="$(mktemp -d)"
  export ISSUES_DIR="${TMPDIR_TEST}/poll-pr-99"
  mkdir -p "$ISSUES_DIR"
  export PROCESSED_IDS_FILE="${ISSUES_DIR}/processed-comment-ids.txt"
  export REPLIED_IDS_FILE="${ISSUES_DIR}/replied-comment-ids.txt"
  touch "$PROCESSED_IDS_FILE" "$REPLIED_IDS_FILE"
  export TOTAL_POLLS=1
  export BLOCKED_EXIT=false
  export COMMITS_PUSHED=0
  export CONTRADICTION_FIRED=false
  # shellcheck source=../poll_compound.sh
  source "${BATS_TEST_DIRNAME}/../poll_compound.sh"
}

teardown() { rm -rf "$TMPDIR_TEST"; }

@test "should_emit_compound: false when loop did nothing" {
  run should_emit_compound
  [ "$status" -ne 0 ]
}

@test "should_emit_compound: true when commits were pushed" {
  COMMITS_PUSHED=1
  run should_emit_compound
  [ "$status" -eq 0 ]
}

@test "should_emit_compound: true when multiple polls ran" {
  TOTAL_POLLS=2
  run should_emit_compound
  [ "$status" -eq 0 ]
}

@test "should_emit_compound: true when blocked" {
  BLOCKED_EXIT=true
  run should_emit_compound
  [ "$status" -eq 0 ]
}

@test "should_emit_compound: true when contradiction fired" {
  CONTRADICTION_FIRED=true
  run should_emit_compound
  [ "$status" -eq 0 ]
}

@test "should_emit_compound: true when any comments were processed" {
  echo "123456" >> "$PROCESSED_IDS_FILE"
  run should_emit_compound
  [ "$status" -eq 0 ]
}
