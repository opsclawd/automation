#!/usr/bin/env bats

# Two roots are tracked here:
#  - REAL_REPO_ROOT: the actual repo this test file lives in. Used ONLY for
#    structural greps against scripts/ai-pr-review-poll (read-only).
#  - FIXTURE_REPO:   a throwaway git repo created in TMPDIR_TEST. Used as the
#    target of `_guard_main_checkout`, which runs `git reset --hard HEAD` and
#    `git clean -fd` — destructive ops that must NEVER hit the real worktree.
#
# The guard function is sourced from the real script (REAL_REPO_ROOT) but
# operates on $REPO_ROOT, which is reassigned to FIXTURE_REPO before each
# guard test invocation.

setup() {
  REAL_REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  TMPDIR_TEST="$(mktemp -d)"
  export AI_RUN_EVENTS_FILE="$TMPDIR_TEST/events.jsonl"
  export AI_RUN_DISPLAY_ID="test-main-guard-$(date +%s)"
  export POLL_COUNT=1
  export ISSUES_DIR="$TMPDIR_TEST"

  # Build an isolated git repo for guard tests. Minimum surface needed by the
  # guard: a working tree with an initial commit so HEAD exists, plus a
  # tracked .gitignore to mutate.
  FIXTURE_REPO="$TMPDIR_TEST/fixture-repo"
  mkdir -p "$FIXTURE_REPO"
  git -C "$FIXTURE_REPO" init -q
  git -C "$FIXTURE_REPO" config user.email "test@example.com"
  git -C "$FIXTURE_REPO" config user.name "test"
  : > "$FIXTURE_REPO/.gitignore"
  git -C "$FIXTURE_REPO" add .gitignore
  git -C "$FIXTURE_REPO" commit -q -m "init"

  # Source warn/log + _guard_main_checkout from the real script. These will
  # reference $REPO_ROOT at call time, so guard tests must set REPO_ROOT to
  # FIXTURE_REPO before invoking.
  # shellcheck source=../emit_event.sh
  source "${BATS_TEST_DIRNAME}/../emit_event.sh"

  eval "$(awk '
    /^(warn|log)\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$REAL_REPO_ROOT/scripts/ai-pr-review-poll")"

  eval "$(awk '
    /^_guard_main_checkout\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$REAL_REPO_ROOT/scripts/ai-pr-review-poll")"
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

@test "_guard_main_checkout is a no-op when POLL_WORKTREE equals REPO_ROOT" {
  REPO_ROOT="$FIXTURE_REPO"
  export POLL_WORKTREE="$FIXTURE_REPO"
  run _guard_main_checkout "test"
  [ "$status" -eq 0 ]
}

@test "_guard_main_checkout is a no-op when main checkout is clean" {
  REPO_ROOT="$FIXTURE_REPO"
  export POLL_WORKTREE="$TMPDIR_TEST/fake-worktree"
  mkdir -p "$POLL_WORKTREE"
  run _guard_main_checkout "test"
  [ "$status" -eq 0 ]
}

@test "_guard_main_checkout resets leaked changes in main checkout" {
  REPO_ROOT="$FIXTURE_REPO"
  export POLL_WORKTREE="$TMPDIR_TEST/fake-worktree"
  mkdir -p "$POLL_WORKTREE"

  echo "# __test_guard_leak_$$" >> "$FIXTURE_REPO/.gitignore"

  run _guard_main_checkout "test"
  [ "$status" -eq 0 ]

  # After the guard runs, the fixture .gitignore must be clean (reset to HEAD).
  run git -C "$FIXTURE_REPO" diff --quiet
  [ "$status" -eq 0 ]

  run jq -e '.type == "post-pr-review.main_leak_detected"' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
}

@test "_guard_main_checkout resets staged leaked changes (regression: PR #132 reviewer)" {
  REPO_ROOT="$FIXTURE_REPO"
  export POLL_WORKTREE="$TMPDIR_TEST/fake-worktree"
  mkdir -p "$POLL_WORKTREE"

  # Simulate `git add -A` having staged a leak — `git checkout -- .` alone
  # would leave the staged entry behind. The guard must clear the index too.
  echo "leak" >> "$FIXTURE_REPO/.gitignore"
  git -C "$FIXTURE_REPO" add .gitignore

  run _guard_main_checkout "test"
  [ "$status" -eq 0 ]

  # Both working tree and index must be clean.
  run git -C "$FIXTURE_REPO" diff --quiet
  [ "$status" -eq 0 ]
  run git -C "$FIXTURE_REPO" diff --cached --quiet
  [ "$status" -eq 0 ]
}

@test "_guard_main_checkout removes untracked leaked files" {
  REPO_ROOT="$FIXTURE_REPO"
  export POLL_WORKTREE="$TMPDIR_TEST/fake-worktree"
  mkdir -p "$POLL_WORKTREE"

  echo "untracked" > "$FIXTURE_REPO/leaked-untracked.txt"

  run _guard_main_checkout "test"
  [ "$status" -eq 0 ]

  [ ! -f "$FIXTURE_REPO/leaked-untracked.txt" ]
}

@test "_guard_main_checkout emits event with pollIteration metadata" {
  REPO_ROOT="$FIXTURE_REPO"
  export POLL_WORKTREE="$TMPDIR_TEST/fake-worktree"
  mkdir -p "$POLL_WORKTREE"
  export POLL_COUNT=7

  echo "# __test_guard_leak2_$$" >> "$FIXTURE_REPO/.gitignore"
  _guard_main_checkout "test"

  run jq -e '.metadata.pollIteration == 7' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
}

@test "ai-pr-review-poll has no pushd callsites" {
  run grep -c 'pushd' "$REAL_REPO_ROOT/scripts/ai-pr-review-poll"
  [ "$output" -eq 0 ]
}

@test "ai-pr-review-poll has no popd callsites" {
  run grep -c 'popd' "$REAL_REPO_ROOT/scripts/ai-pr-review-poll"
  [ "$output" -eq 0 ]
}

@test "ai-pr-review-poll has _guard_main_checkout function" {
  run grep -q '_guard_main_checkout()' "$REAL_REPO_ROOT/scripts/ai-pr-review-poll"
  [ "$status" -eq 0 ]
}

@test "ai-pr-review-poll has two _guard_main_checkout callsites" {
  callsite_count=$(grep -c '_guard_main_checkout' "$REAL_REPO_ROOT/scripts/ai-pr-review-poll")
  [ "$callsite_count" -eq 3 ]
}

@test "ai-pr-review-poll prompt forbids pushing to main" {
  run grep -c 'Never push to main' "$REAL_REPO_ROOT/scripts/ai-pr-review-poll"
  [ "$output" -eq 1 ]
}

@test "ai-pr-review-poll Step 3 template has branch-name comment" {
  run grep -c 'Do NOT change this branch name' "$REAL_REPO_ROOT/scripts/ai-pr-review-poll"
  [ "$output" -eq 1 ]
}
