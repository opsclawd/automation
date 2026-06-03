#!/usr/bin/env bats
# Tests for scripts/lib/comment-state.sh
# Per-comment state machine for PR review poll.

setup() {
  TMPDIR_TEST="$(mktemp -d)"
  export ISSUES_DIR="${TMPDIR_TEST}/poll-pr-42"
  mkdir -p "$ISSUES_DIR"
  export COMMENT_STATE_FILE="${ISSUES_DIR}/comment-state.json"
  export PROCESSED_IDS_FILE="${ISSUES_DIR}/processed-comment-ids.txt"
  export REPLIED_IDS_FILE="${ISSUES_DIR}/replied-comment-ids.txt"
  export POLL_COUNT=1
  export PR_BRANCH="test-branch"
  export PR_NUMBER=42
  export OWNER_REPO="owner/repo"
  export AI_RUN_EVENTS_FILE="${TMPDIR_TEST}/events.jsonl"
  export AI_RUN_DISPLAY_ID="test-cs-$$"

  # Stub log/warn
  log() { echo "LOG: $*" >&2; }
  warn() { echo "WARN: $*" >&2; }
  export -f log warn

  # Use real emit_event from emit_event.sh
  # shellcheck source=../emit_event.sh
  source "${BATS_TEST_DIRNAME}/../emit_event.sh"

  touch "$PROCESSED_IDS_FILE" "$REPLIED_IDS_FILE"

  # source the library
  # shellcheck source=../comment-state.sh
  source "${BATS_TEST_DIRNAME}/../comment-state.sh"
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

# init_comment_state tests
@test "init_comment_state creates empty JSON if file absent" {
  rm -f "$COMMENT_STATE_FILE"
  init_comment_state ""
  [ -f "$COMMENT_STATE_FILE" ]
  run jq -e '. == {}' "$COMMENT_STATE_FILE"
  [ "$status" -eq 0 ]
}

@test "init_comment_state seeds new IDs as pending" {
  init_comment_state "111 222"
  run jq -r --arg id "111" '.[$id].state // "pending"' "$COMMENT_STATE_FILE"
  [ "$output" = "pending" ]
  run jq -r --arg id "222" '.[$id].state // "pending"' "$COMMENT_STATE_FILE"
  [ "$output" = "pending" ]
}

@test "init_comment_state is idempotent — existing IDs preserved" {
  echo '{"111": {"state": "replied", "attempts": 1, "last_poll": 1, "last_result": null, "outcome": null, "commit_sha": null, "reply_verified": true, "blocked_reason": null, "no_fix_reason": null}}' > "$COMMENT_STATE_FILE"
  init_comment_state "111 333"
  run jq -r --arg id "111" '.[$id].state // "pending"' "$COMMENT_STATE_FILE"
  [ "$output" = "replied" ]
  run jq -r --arg id "333" '.[$id].state // "pending"' "$COMMENT_STATE_FILE"
  [ "$output" = "pending" ]
}

# get_comment_state and get_comment_field tests
@test "get_comment_state returns state for existing ID" {
  echo '{"42": {"state": "replied", "attempts": 1, "last_poll": 1, "last_result": null, "outcome": null, "commit_sha": null, "reply_verified": false, "blocked_reason": null, "no_fix_reason": null}}' > "$COMMENT_STATE_FILE"
  run get_comment_state "42"
  [ "$output" = "replied" ]
}

@test "get_comment_state defaults to pending for missing ID" {
  echo '{}' > "$COMMENT_STATE_FILE"
  run get_comment_state "999"
  [ "$output" = "pending" ]
}

@test "get_comment_field reads arbitrary field" {
  echo '{"10": {"state": "processed", "attempts": 2, "last_poll": 3, "last_result": "ALL_DONE", "outcome": "fixed", "commit_sha": "abc1234", "reply_verified": true, "blocked_reason": null, "no_fix_reason": null}}' > "$COMMENT_STATE_FILE"
  run get_comment_field "10" "outcome"
  [ "$output" = "fixed" ]
  run get_comment_field "10" "commit_sha"
  [ "$output" = "abc1234" ]
}

# set_comment_state tests
@test "set_comment_state transitions pending to replied" {
  echo '{"5": {"state": "pending", "attempts": 0, "last_poll": 1, "last_result": null, "outcome": null, "commit_sha": null, "reply_verified": false, "blocked_reason": null, "no_fix_reason": null}}' > "$COMMENT_STATE_FILE"
  set_comment_state "5" "replied"
  run jq -r '.["5"].state' "$COMMENT_STATE_FILE"
  [ "$output" = "replied" ]
}

@test "set_comment_state increments attempts when transitioning back to pending" {
  echo '{"5": {"state": "replied", "attempts": 1, "last_poll": 1, "last_result": null, "outcome": null, "commit_sha": null, "reply_verified": false, "blocked_reason": null, "no_fix_reason": null}}' > "$COMMENT_STATE_FILE"
  set_comment_state "5" "pending"
  run jq '.["5"].attempts' "$COMMENT_STATE_FILE"
  [ "$output" = "2" ]
}

@test "set_comment_state sets blocked_reason when blocking" {
  echo '{"5": {"state": "pending", "attempts": 2, "last_poll": 2, "last_result": "unresolved", "outcome": "unresolved", "commit_sha": null, "reply_verified": false, "blocked_reason": null, "no_fix_reason": null}}' > "$COMMENT_STATE_FILE"
  set_comment_state "5" "blocked" "Exceeded 2 attempts"
  run jq -r '.["5"].blocked_reason' "$COMMENT_STATE_FILE"
  [ "$output" = "Exceeded 2 attempts" ]
}

# update_comment_outcomes tests
@test "update_comment_outcomes merges fixed outcome" {
  echo '{"100": {"state": "pending", "attempts": 0, "last_poll": 0, "last_result": null, "outcome": null, "commit_sha": null, "reply_verified": false, "blocked_reason": null, "no_fix_reason": null}}' > "$COMMENT_STATE_FILE"
  echo '{"100": {"outcome": "fixed", "commit_sha": "abc1234def5678"}}' > "${TMPDIR_TEST}/outcomes.json"
  update_comment_outcomes "${TMPDIR_TEST}/outcomes.json"
  run jq -r '.["100"].outcome' "$COMMENT_STATE_FILE"
  [ "$output" = "fixed" ]
  run jq -r '.["100"].commit_sha' "$COMMENT_STATE_FILE"
  [ "$output" = "abc1234def5678" ]
  run jq -r '.["100"].last_result' "$COMMENT_STATE_FILE"
  [ "$output" = "ALL_DONE" ]
}

@test "update_comment_outcomes merges no_fix_needed outcome" {
  printf '{"100": {"state": "pending", "attempts": 0, "last_poll": 0, "last_result": null, "outcome": null, "commit_sha": null, "reply_verified": false, "blocked_reason": null, "no_fix_reason": null}}' > "$COMMENT_STATE_FILE"
  echo '{"100": {"outcome": "no_fix_needed", "reason": "Comment refers to removed code"}}' > "${TMPDIR_TEST}/outcomes.json"
  update_comment_outcomes "${TMPDIR_TEST}/outcomes.json"
  run jq -r '.["100"].outcome' "$COMMENT_STATE_FILE"
  [ "$output" = "no_fix_needed" ]
  run jq -r '.["100"].no_fix_reason' "$COMMENT_STATE_FILE"
  [ "$output" = "Comment refers to removed code" ]
}

@test "update_comment_outcomes treats missing file as unresolved" {
  echo '{"200": {"state": "pending", "attempts": 0, "last_poll": 0, "last_result": null, "outcome": null, "commit_sha": null, "reply_verified": false, "blocked_reason": null, "no_fix_reason": null}}' > "$COMMENT_STATE_FILE"
  update_comment_outcomes "${TMPDIR_TEST}/nonexistent.json"
  run jq -r '.["200"].outcome' "$COMMENT_STATE_FILE"
  [ "$output" = "unresolved" ]
}

@test "update_comment_outcomes treats missing entries as unresolved" {
  echo '{"300": {"state": "pending", "attempts": 0, "last_poll": 0, "last_result": null, "outcome": null, "commit_sha": null, "reply_verified": false, "blocked_reason": null, "no_fix_reason": null}}' > "$COMMENT_STATE_FILE"
  echo '{}' > "${TMPDIR_TEST}/outcomes.json"
  update_comment_outcomes "${TMPDIR_TEST}/outcomes.json"
  run jq -r '.["300"].outcome' "$COMMENT_STATE_FILE"
  [ "$output" = "unresolved" ]
}

# check_stuck_comments tests
@test "check_stuck_comments blocks comments with 2+ unresolved attempts" {
  printf '{"555": {"state": "pending", "attempts": 2, "last_poll": 2, "last_result": "unresolved", "outcome": "unresolved", "commit_sha": null, "reply_verified": false, "blocked_reason": null, "no_fix_reason": null}}' > "$COMMENT_STATE_FILE"
  check_stuck_comments
  run jq -r '.["555"].state' "$COMMENT_STATE_FILE"
  [ "$output" = "blocked" ]
}

@test "check_stuck_comments does not block comments under threshold" {
  printf '{"666": {"state": "pending", "attempts": 1, "last_poll": 1, "last_result": "unresolved", "outcome": "unresolved", "commit_sha": null, "reply_verified": false, "blocked_reason": null, "no_fix_reason": null}}' > "$COMMENT_STATE_FILE"
  check_stuck_comments
  run jq -r '.["666"].state' "$COMMENT_STATE_FILE"
  [ "$output" = "pending" ]
}

@test "check_stuck_comments emits blocked event" {
  printf '{"555": {"state": "pending", "attempts": 2, "last_poll": 2, "last_result": "unresolved", "outcome": "unresolved", "commit_sha": null, "reply_verified": false, "blocked_reason": null, "no_fix_reason": null}}' > "$COMMENT_STATE_FILE"
  : > "$AI_RUN_EVENTS_FILE"
  check_stuck_comments
  local count
  count=$(jq -s '[.[] | select(.type == "post-pr-review.comment.blocked")] | length' "$AI_RUN_EVENTS_FILE")
  [ "$count" -ge 1 ]
}

# derive_compat_files tests
@test "derive_compat_files produces correct text files" {
  printf '{"10": {"state": "processed", "attempts": 1, "last_poll": 2, "last_result": "ALL_DONE", "outcome": "fixed", "commit_sha": "abc1234", "reply_verified": true, "blocked_reason": null, "no_fix_reason": null}, "20": {"state": "replied", "attempts": 0, "last_poll": 1, "last_result": null, "outcome": null, "commit_sha": null, "reply_verified": true, "blocked_reason": null, "no_fix_reason": null}, "30": {"state": "pending", "attempts": 0, "last_poll": 0, "last_result": null, "outcome": null, "commit_sha": null, "reply_verified": false, "blocked_reason": null, "no_fix_reason": null}}' > "$COMMENT_STATE_FILE"
  derive_compat_files
  run cat "$PROCESSED_IDS_FILE"
  [ "$output" = "10" ]
  run cat "$REPLIED_IDS_FILE"
  [ "$output" = "20" ]
}

@test "derive_compat_files handles empty state" {
  echo '{}' > "$COMMENT_STATE_FILE"
  derive_compat_files
  run cat "$PROCESSED_IDS_FILE"
  [ -z "$output" ]
  run cat "$REPLIED_IDS_FILE"
  [ -z "$output" ]
}

# verify_comment_commit tests
@test "verify_comment_commit rejects empty or short SHA" {
  local fixture_repo="${TMPDIR_TEST}/fixture-verify"
  mkdir -p "$fixture_repo" && git -C "$fixture_repo" init -q
  git -C "$fixture_repo" config user.email "test@example.com"
  git -C "$fixture_repo" config user.name "test"
  : > "$fixture_repo/.gitignore"
  git -C "$fixture_repo" add .gitignore && git -C "$fixture_repo" commit -q -m "init"

  run verify_comment_commit "1" "" ""
  [ "$status" -ne 0 ]

  run verify_comment_commit "1" "..." ""
  [ "$status" -ne 0 ]

  run verify_comment_commit "1" "abc" ""
  [ "$status" -ne 0 ]
}

@test "verify_comment_commit rejects SHA not on origin branch" {
  run verify_comment_commit "1" "0000000000000000000000000000000000000000" ""
  [ "$status" -ne 0 ]
}

# cleanup_dirty_worktree tests
@test "cleanup_dirty_worktree archives diff and resets" {
  local wt="${TMPDIR_TEST}/dirty-wt"
  mkdir -p "$wt" && git -C "$wt" init -q
  git -C "$wt" config user.email "test@example.com"
  git -C "$wt" config user.name "test"
  : > "$wt/tracked-file"
  git -C "$wt" add tracked-file && git -C "$wt" commit -q -m "init"
  echo "dirty change" >> "$wt/tracked-file"

  # Before cleanup: diff exists
  ! git -C "$wt" diff --quiet 2>/dev/null

  cleanup_dirty_worktree "$wt"

  # After cleanup: worktree is clean
  git -C "$wt" diff --quiet 2>/dev/null
  [ -f "${ISSUES_DIR}/dirty-worktree-p1.diff" ]
}

@test "cleanup_dirty_worktree is no-op on clean worktree" {
  local wt="${TMPDIR_TEST}/clean-wt"
  mkdir -p "$wt" && git -C "$wt" init -q
  git -C "$wt" config user.email "test@example.com"
  git -C "$wt" config user.name "test"
  : > "$wt/tracked-file"
  git -C "$wt" add tracked-file && git -C "$wt" commit -q -m "init"

  cleanup_dirty_worktree "$wt"

  # No diff file created for clean worktree
  [ ! -f "${ISSUES_DIR}/dirty-worktree-p1.diff" ]
}

# can_transition_to_processed acceptance tests
@test "AC1: reply exists but no commit and no rationale → not processed" {
  echo '{"400": {"state": "replied", "attempts": 1, "last_poll": 1, "last_result": "ALL_DONE", "outcome": "fixed", "commit_sha": null, "reply_verified": true, "blocked_reason": null, "no_fix_reason": null}}' > "$COMMENT_STATE_FILE"
  run can_transition_to_processed "400"
  [ "$status" -ne 0 ]
}

@test "AC2: NO_FIXES_NEEDED with reply + rationale → can transition to processed" {
  echo '{"400": {"state": "replied", "attempts": 1, "last_poll": 1, "last_result": "NO_FIXES_NEEDED", "outcome": "no_fix_needed", "commit_sha": null, "reply_verified": true, "blocked_reason": null, "no_fix_reason": "Comment refers to removed code"}}' > "$COMMENT_STATE_FILE"
  run can_transition_to_processed "400"
  [ "$status" -eq 0 ]
}

@test "AC3: fixed with valid commit SHA → can transition to processed" {
  echo '{"400": {"state": "replied", "attempts": 1, "last_poll": 1, "last_result": "ALL_DONE", "outcome": "fixed", "commit_sha": "abc123def456789", "reply_verified": true, "blocked_reason": null, "no_fix_reason": null}}' > "$COMMENT_STATE_FILE"
  run can_transition_to_processed "400"
  [ "$status" -eq 0 ]
}

@test "reply_verified false → cannot transition to processed even with commit" {
  echo '{"400": {"state": "pending", "attempts": 0, "last_poll": 1, "last_result": null, "outcome": "fixed", "commit_sha": "abc123def456789", "reply_verified": false, "blocked_reason": null, "no_fix_reason": null}}' > "$COMMENT_STATE_FILE"
  run can_transition_to_processed "400"
  [ "$status" -ne 0 ]
}