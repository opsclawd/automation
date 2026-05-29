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

  eval "$(awk '
    /^_capture_main_state\(\)/ { found=1 }
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

@test "_guard_main_checkout rewinds HEAD when agent committed a leak (regression: PR #132 comment 3322104761)" {
  REPO_ROOT="$FIXTURE_REPO"
  export POLL_WORKTREE="$TMPDIR_TEST/fake-worktree"
  mkdir -p "$POLL_WORKTREE"

  local pre_state
  pre_state=$(_capture_main_state)
  local pre_sha="${pre_state%%|*}"

  # Simulate agent running `git add -A && git commit` in main: HEAD advances
  # to a clean leaked commit. Dirty checks alone won't catch this.
  echo "leaked content" > "$FIXTURE_REPO/leaked.txt"
  git -C "$FIXTURE_REPO" add leaked.txt
  git -C "$FIXTURE_REPO" -c user.email=t@t -c user.name=t commit -q -m "leaked"

  local leaked_sha
  leaked_sha=$(git -C "$FIXTURE_REPO" rev-parse HEAD)
  [ "$leaked_sha" != "$pre_sha" ]

  run _guard_main_checkout "test" "$pre_state"
  [ "$status" -eq 0 ]

  # HEAD must be back at pre_sha and the leaked file must be gone.
  local final_sha
  final_sha=$(git -C "$FIXTURE_REPO" rev-parse HEAD)
  [ "$final_sha" = "$pre_sha" ]
  [ ! -f "$FIXTURE_REPO/leaked.txt" ]
}

@test "_guard_main_checkout preserves pre-existing dirty work (regression: PR #132 comment 3322133613)" {
  REPO_ROOT="$FIXTURE_REPO"
  export POLL_WORKTREE="$TMPDIR_TEST/fake-worktree"
  mkdir -p "$POLL_WORKTREE"

  # Developer has unstaged local work BEFORE the agent runs.
  echo "developer edit" >> "$FIXTURE_REPO/.gitignore"
  echo "dev untracked" > "$FIXTURE_REPO/dev-scratch.txt"

  # Capture state AFTER the dirty edits (simulating pre-agent baseline).
  local pre_state
  pre_state=$(_capture_main_state)

  # Agent runs (in this scenario, doesn't add to the dirty state).
  run _guard_main_checkout "test" "$pre_state"
  [ "$status" -eq 0 ]

  # Developer's work must be preserved: both the tracked edit and the
  # untracked file must still be present.
  run grep -q "developer edit" "$FIXTURE_REPO/.gitignore"
  [ "$status" -eq 0 ]
  [ -f "$FIXTURE_REPO/dev-scratch.txt" ]

  # Event log should record the skip rather than a leak.
  run jq -e '.type == "post-pr-review.main_dirty_preexisting"' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
}

@test "_guard_main_checkout rewinds HEAD but preserves untracked when pre-agent was dirty" {
  REPO_ROOT="$FIXTURE_REPO"
  export POLL_WORKTREE="$TMPDIR_TEST/fake-worktree"
  mkdir -p "$POLL_WORKTREE"

  # Developer has untracked file before agent runs.
  echo "dev work" > "$FIXTURE_REPO/dev-untracked.txt"
  local pre_state
  pre_state=$(_capture_main_state)
  local pre_sha="${pre_state%%|*}"

  # Agent commits a leak (HEAD moves).
  echo "leaked" > "$FIXTURE_REPO/leaked.txt"
  git -C "$FIXTURE_REPO" add leaked.txt
  git -C "$FIXTURE_REPO" -c user.email=t@t -c user.name=t commit -q -m "leak"

  run _guard_main_checkout "test" "$pre_state"
  [ "$status" -eq 0 ]

  # HEAD is rewound (always safe — HEAD move is unambiguous leak).
  local final_sha
  final_sha=$(git -C "$FIXTURE_REPO" rev-parse HEAD)
  [ "$final_sha" = "$pre_sha" ]

  # Developer's untracked file must NOT have been cleaned, because the
  # pre-agent state was already dirty and we can't tell pre-existing
  # untracked from new untracked without extra bookkeeping.
  [ -f "$FIXTURE_REPO/dev-untracked.txt" ]
}

@test "_guard_main_checkout does not rewind HEAD when no expected_sha is passed (back-compat)" {
  REPO_ROOT="$FIXTURE_REPO"
  export POLL_WORKTREE="$TMPDIR_TEST/fake-worktree"
  mkdir -p "$POLL_WORKTREE"

  # Move HEAD forward; without expected_sha the guard must not rewind it,
  # because it has no way to know the move was a leak.
  echo "advance" > "$FIXTURE_REPO/x.txt"
  git -C "$FIXTURE_REPO" add x.txt
  git -C "$FIXTURE_REPO" -c user.email=t@t -c user.name=t commit -q -m "advance"

  local after_sha
  after_sha=$(git -C "$FIXTURE_REPO" rev-parse HEAD)

  run _guard_main_checkout "test"
  [ "$status" -eq 0 ]

  local final_sha
  final_sha=$(git -C "$FIXTURE_REPO" rev-parse HEAD)
  [ "$final_sha" = "$after_sha" ]
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
  # Match callsites only (function invocation at start of indentation),
  # excluding the function definition itself and any references in comments.
  callsite_count=$(grep -cE '^[[:space:]]+_guard_main_checkout\b' "$REAL_REPO_ROOT/scripts/ai-pr-review-poll")
  [ "$callsite_count" -eq 2 ]
}

@test "ai-pr-review-poll prompt forbids pushing to main" {
  run grep -c 'Never push to main' "$REAL_REPO_ROOT/scripts/ai-pr-review-poll"
  [ "$output" -eq 1 ]
}

@test "ai-pr-review-poll Step 3 template has branch-name comment" {
  run grep -c 'Do NOT change this branch name' "$REAL_REPO_ROOT/scripts/ai-pr-review-poll"
  [ "$output" -eq 1 ]
}
