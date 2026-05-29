#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  TMPDIR_TEST="$(mktemp -d)"
  export AI_RUN_EVENTS_FILE="$TMPDIR_TEST/events.jsonl"
  export AI_RUN_DISPLAY_ID="test-main-guard-$(date +%s)"
  export POLL_COUNT=1
  export ISSUES_DIR="$TMPDIR_TEST"

  # shellcheck source=../emit_event.sh
  source "${BATS_TEST_DIRNAME}/../emit_event.sh"

  eval "$(awk '
    /^(warn|log)\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$REPO_ROOT/scripts/ai-pr-review-poll")"

  eval "$(awk '
    /^_guard_main_checkout\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$REPO_ROOT/scripts/ai-pr-review-poll")"
}

teardown() {
  git -C "$REPO_ROOT" checkout -- .gitignore 2>/dev/null || true
  rm -rf "$TMPDIR_TEST"
}

@test "_guard_main_checkout is a no-op when POLL_WORKTREE equals REPO_ROOT" {
  export POLL_WORKTREE="$REPO_ROOT"
  run _guard_main_checkout "test"
  [ "$status" -eq 0 ]
}

@test "_guard_main_checkout is a no-op when main checkout is clean" {
  export POLL_WORKTREE="$TMPDIR_TEST/fake-worktree"
  mkdir -p "$POLL_WORKTREE"
  run _guard_main_checkout "test"
  [ "$status" -eq 0 ]
}

@test "_guard_main_checkout resets leaked changes in main checkout" {
  export POLL_WORKTREE="$TMPDIR_TEST/fake-worktree"
  mkdir -p "$POLL_WORKTREE"

  local marker="# __test_guard_leak_$$"
  echo "$marker" >> "$REPO_ROOT/.gitignore"

  run _guard_main_checkout "test"
  [ "$status" -eq 0 ]

  git -C "$REPO_ROOT" checkout -- .gitignore

  run jq -e '.type == "post-pr-review.main_leak_detected"' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
}

@test "_guard_main_checkout emits event with pollIteration metadata" {
  export POLL_WORKTREE="$TMPDIR_TEST/fake-worktree"
  mkdir -p "$POLL_WORKTREE"
  export POLL_COUNT=7

  local marker="# __test_guard_leak2_$$"
  echo "$marker" >> "$REPO_ROOT/.gitignore"
  _guard_main_checkout "test"
  git -C "$REPO_ROOT" checkout -- .gitignore

  run jq -e '.metadata.pollIteration == 7' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
}

@test "ai-pr-review-poll has no pushd callsites" {
  run grep -c 'pushd' "$REPO_ROOT/scripts/ai-pr-review-poll"
  [ "$output" -eq 0 ]
}

@test "ai-pr-review-poll has no popd callsites" {
  run grep -c 'popd' "$REPO_ROOT/scripts/ai-pr-review-poll"
  [ "$output" -eq 0 ]
}

@test "ai-pr-review-poll has _guard_main_checkout function" {
  run grep -q '_guard_main_checkout()' "$REPO_ROOT/scripts/ai-pr-review-poll"
  [ "$status" -eq 0 ]
}

@test "ai-pr-review-poll has two _guard_main_checkout callsites" {
  callsite_count=$(grep -c '_guard_main_checkout' "$REPO_ROOT/scripts/ai-pr-review-poll")
  [ "$callsite_count" -eq 3 ]
}

@test "ai-pr-review-poll prompt forbids pushing to main" {
  run grep -c 'Never push to main' "$REPO_ROOT/scripts/ai-pr-review-poll"
  [ "$output" -eq 1 ]
}

@test "ai-pr-review-poll Step 3 template has branch-name comment" {
  run grep -c 'Do NOT change this branch name' "$REPO_ROOT/scripts/ai-pr-review-poll"
  [ "$output" -eq 1 ]
}
