#!/usr/bin/env bats

# Tests for _stash_and_conditionally_commit (scripts/lib/fix-review-stash.sh)

setup() {
  SCRIPT_DIR="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  source "${SCRIPT_DIR}/fix-review-stash.sh"

  TMPDIR_TEST="$(mktemp -d)"

  # Create a throwaway git repo for the worktree
  FIXTURE_REPO="$TMPDIR_TEST/worktree"
  mkdir -p "$FIXTURE_REPO"
  git -C "$FIXTURE_REPO" init -q
  git -C "$FIXTURE_REPO" config user.email "test@example.com"
  git -C "$FIXTURE_REPO" config user.name "test"
  echo "initial" > "$FIXTURE_REPO/.gitignore"
  git -C "$FIXTURE_REPO" add .gitignore
  git -C "$FIXTURE_REPO" commit -q -m "init"

  # Stub functions
  log() { :; }
  warn() { :; }
  emit_event() { :; }

  # Create a passing revalidate log
  cat > "$TMPDIR_TEST/revalidate-pass.log" << 'LOG'
=== pnpm build ===
=== pnpm lint ===
=== pnpm typecheck ===
=== pnpm test ===
=== pnpm test:bash ===
LOG

  # Create a failing revalidate log
  cat > "$TMPDIR_TEST/revalidate-fail.log" << 'LOG'
=== pnpm build ===
=== pnpm lint ===
[lint failed]
=== pnpm typecheck ===
=== pnpm test ===
=== pnpm test:bash ===
LOG
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

@test "_stash_and_conditionally_commit is a no-op on clean tree" {
  run _stash_and_conditionally_commit "$FIXTURE_REPO" "T1" "fix: T1" "$TMPDIR_TEST/revalidate-pass.log"
  [ "$status" -eq 0 ]
  # No stash should exist
  local stash_count
  stash_count=$(git -C "$FIXTURE_REPO" stash list | wc -l)
  [ "$stash_count" -eq 0 ]
}

@test "_stash_and_conditionally_commit stashes and commits on green revalidate" {
  echo "agent-fix" > "$FIXTURE_REPO/fix.ts"
  git -C "$FIXTURE_REPO" add fix.ts

  run _stash_and_conditionally_commit "$FIXTURE_REPO" "T1" "fix: T1 auto-commit" "$TMPDIR_TEST/revalidate-pass.log"
  [ "$status" -eq 0 ]

  # The fix should be committed (tree clean, stash empty)
  run git -C "$FIXTURE_REPO" diff --exit-code HEAD
  [ "$status" -eq 0 ]

  # The commit message should contain the auto-commit text
  run git -C "$FIXTURE_REPO" log --oneline -1
  [[ "$output" == *"auto-commit"* ]]

  # Stash should be empty
  local stash_count
  stash_count=$(git -C "$FIXTURE_REPO" stash list | wc -l)
  [ "$stash_count" -eq 0 ]
}

@test "_stash_and_conditionally_commit stashes and retains on red revalidate" {
  echo "agent-partial-fix" > "$FIXTURE_REPO/partial.ts"
  git -C "$FIXTURE_REPO" add partial.ts

  run _stash_and_conditionally_commit "$FIXTURE_REPO" "T2" "fix: T2 auto-commit" "$TMPDIR_TEST/revalidate-fail.log"
  [ "$status" -eq 0 ]

  # Tree should be clean (changes stashed, not restored)
  run git -C "$FIXTURE_REPO" diff --exit-code HEAD
  [ "$status" -eq 0 ]

  # Stash should contain the retained work
  local stash_count
  stash_count=$(git -C "$FIXTURE_REPO" stash list | wc -l)
  [ "$stash_count" -eq 1 ]

  # Stash message should mention the task
  run git -C "$FIXTURE_REPO" stash list
  [[ "$output" == *"fix-review-task-T2"* ]]
}

@test "_stash_and_conditionally_commit emits work_committed event on green" {
  echo "agent-fix" > "$FIXTURE_REPO/fix.ts"
  git -C "$FIXTURE_REPO" add fix.ts

  # Track emit_event calls
  _events=()
  emit_event() { _events+=("$3"); }

  _stash_and_conditionally_commit "$FIXTURE_REPO" "T1" "fix: T1" "$TMPDIR_TEST/revalidate-pass.log"

  # Should have emitted task.work_committed
  [[ " ${_events[*]} " == *" task.work_committed "* ]]
}

@test "_stash_and_conditionally_commit emits stash_retained event on red" {
  echo "partial" > "$FIXTURE_REPO/partial.ts"
  git -C "$FIXTURE_REPO" add partial.ts

  _events=()
  emit_event() { _events+=("$3"); }

  _stash_and_conditionally_commit "$FIXTURE_REPO" "T2" "fix: T2" "$TMPDIR_TEST/revalidate-fail.log"

  [[ " ${_events[*]} " == *" task.stash_retained "* ]]
}

@test "_stash_and_conditionally_commit handles staged new files" {
  echo "staged-agent-work" > "$FIXTURE_REPO/new-file.ts"
  git -C "$FIXTURE_REPO" add new-file.ts

  run _stash_and_conditionally_commit "$FIXTURE_REPO" "T3" "fix: T3" "$TMPDIR_TEST/revalidate-pass.log"
  [ "$status" -eq 0 ]

  # The staged new file should be committed
  run git -C "$FIXTURE_REPO" show HEAD --name-only --format=''
  [[ "$output" == *"new-file.ts"* ]]
}

@test "_stash_and_conditionally_commit returns early for truly untracked files" {
  echo "untracked-agent-work" > "$FIXTURE_REPO/untracked.ts"

  run _stash_and_conditionally_commit "$FIXTURE_REPO" "T3" "fix: T3" "$TMPDIR_TEST/revalidate-pass.log"
  [ "$status" -eq 0 ]

  # Truly untracked files are not detected by git diff HEAD, so the
  # function returns early — the file should remain on disk uncommitted.
  run git -C "$FIXTURE_REPO" log --oneline -1
  [[ "$output" != *"fix: T3"* ]]

  # File should still exist on disk
  [ -f "$FIXTURE_REPO/untracked.ts" ]

  # No stash should have been created
  local stash_count
  stash_count=$(git -C "$FIXTURE_REPO" stash list | wc -l)
  [ "$stash_count" -eq 0 ]
}

@test "_stash_and_conditionally_commit works when _revalidate_is_green is not defined" {
  # Unset the function if it exists
  unset -f _revalidate_is_green 2>/dev/null || true

  echo "fix" > "$FIXTURE_REPO/fix.ts"
  git -C "$FIXTURE_REPO" add fix.ts

  run _stash_and_conditionally_commit "$FIXTURE_REPO" "T4" "fix: T4" "$TMPDIR_TEST/revalidate-pass.log"
  [ "$status" -eq 0 ]

  # Should still commit (fallback reads the log file directly)
  run git -C "$FIXTURE_REPO" log --oneline -1
  [[ "$output" == *"fix: T4"* ]]
}
