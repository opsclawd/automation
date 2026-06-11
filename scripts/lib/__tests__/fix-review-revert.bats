#!/usr/bin/env bats
# Tests for _revert_task_commits (scripts/lib/fix-review-revert.sh)

setup() {
  SCRIPT_DIR="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  source "${SCRIPT_DIR}/fix-review-revert.sh"

  TMPDIR_TEST="$(mktemp -d)"

  FIXTURE_REPO="$TMPDIR_TEST/worktree"
  mkdir -p "$FIXTURE_REPO"
  git -C "$FIXTURE_REPO" init -q
  git -C "$FIXTURE_REPO" config user.email "test@example.com"
  git -C "$FIXTURE_REPO" config user.name "test"
  echo "initial" > "$FIXTURE_REPO/.gitignore"
  git -C "$FIXTURE_REPO" add .gitignore
  git -C "$FIXTURE_REPO" commit -q -m "init"

  warn() { :; }
  emit_event() { :; }

  # Stub _revalidate_is_green (dependency, defined in ai-run-issue-v2)
  _revalidate_is_green() {
    local file=$1
    [[ -f "$file" ]] || return 1
    ! grep -qE '\[(build|lint|typecheck|test|test:bash) failed\]' "$file"
  }
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

@test "_revert_task_commits is a no-op when revalidate is green" {
  local pre_head
  pre_head=$(git -C "$FIXTURE_REPO" rev-parse HEAD)
  echo "fix" > "$FIXTURE_REPO/fix.ts"
  git -C "$FIXTURE_REPO" add fix.ts
  git -C "$FIXTURE_REPO" commit -q -m "fix: something"

  local revalidate_log="$TMPDIR_TEST/revalidate-green.log"
  cat > "$revalidate_log" << 'LOG'
=== pnpm build ===
=== pnpm lint ===
=== pnpm typecheck ===
=== pnpm test ===
=== pnpm test:bash ===
LOG

  run _revert_task_commits "$FIXTURE_REPO" "T1" "$pre_head" "$revalidate_log"
  [ "$status" -eq 0 ]

  # The fix commit should still be present (no revert happened)
  run git -C "$FIXTURE_REPO" log --oneline -1
  [[ "$output" == *"fix: something"* ]]
}

@test "_revert_task_commits is a no-op when HEAD has not moved" {
  local pre_head
  pre_head=$(git -C "$FIXTURE_REPO" rev-parse HEAD)

  local revalidate_log="$TMPDIR_TEST/revalidate-red.log"
  cat > "$revalidate_log" << 'LOG'
=== pnpm build ===
=== pnpm lint ===
[lint failed]
=== pnpm typecheck ===
=== pnpm test ===
=== pnpm test:bash ===
LOG

  run _revert_task_commits "$FIXTURE_REPO" "T2" "$pre_head" "$revalidate_log"
  [ "$status" -eq 0 ]

  # HEAD should still be the same
  run git -C "$FIXTURE_REPO" rev-parse HEAD
  [ "$output" = "$pre_head" ]
}

@test "_revert_task_commits reverts commits when revalidate is red and HEAD has advanced" {
  local pre_head
  pre_head=$(git -C "$FIXTURE_REPO" rev-parse HEAD)

  # Simulate fix agent committing work
  echo "broken-fix" > "$FIXTURE_REPO/fix.ts"
  git -C "$FIXTURE_REPO" add fix.ts
  git -C "$FIXTURE_REPO" commit -q -m "fix: broken fix"

  local revalidate_log="$TMPDIR_TEST/revalidate-red.log"
  cat > "$revalidate_log" << 'LOG'
=== pnpm build ===
=== pnpm lint ===
=== pnpm typecheck ===
=== pnpm test ===
[test failed]
=== pnpm test:bash ===
LOG

  run _revert_task_commits "$FIXTURE_REPO" "T3" "$pre_head" "$revalidate_log"
  [ "$status" -eq 0 ]

  # The broken fix should be reverted (tree should match pre-commit state)
  run git -C "$FIXTURE_REPO" log --oneline
  [[ "$output" == *"Revert"* ]]
  # File should not exist after revert
  [ ! -f "$FIXTURE_REPO/fix.ts" ]
}

@test "_revert_task_commits handles multiple commits since pre-task HEAD" {
  local pre_head
  pre_head=$(git -C "$FIXTURE_REPO" rev-parse HEAD)

  # Simulate fix agent committing multiple times
  echo "fix-1" > "$FIXTURE_REPO/a.ts"
  git -C "$FIXTURE_REPO" add a.ts
  git -C "$FIXTURE_REPO" commit -q -m "fix: part 1"

  echo "fix-2" > "$FIXTURE_REPO/b.ts"
  git -C "$FIXTURE_REPO" add b.ts
  git -C "$FIXTURE_REPO" commit -q -m "fix: part 2"

  local revalidate_log="$TMPDIR_TEST/revalidate-red.log"
  cat > "$revalidate_log" << 'LOG'
=== pnpm build ===
=== pnpm lint ===
=== pnpm typecheck ===
=== pnpm test ===
[test failed]
=== pnpm test:bash ===
LOG

  run _revert_task_commits "$FIXTURE_REPO" "T4" "$pre_head" "$revalidate_log"
  [ "$status" -eq 0 ]

  # Both files should be gone after revert
  [ ! -f "$FIXTURE_REPO/a.ts" ]
  [ ! -f "$FIXTURE_REPO/b.ts" ]
}

@test "_revert_task_commits returns 0 even when revert fails (e.g. conflicts)" {
  local pre_head
  pre_head=$(git -C "$FIXTURE_REPO" rev-parse HEAD)

  # Create a commit that touched a file
  echo "original" > "$FIXTURE_REPO/conflict.ts"
  git -C "$FIXTURE_REPO" add conflict.ts
  git -C "$FIXTURE_REPO" commit -q -m "add conflict.ts"

  local post_add_head
  post_add_head=$(git -C "$FIXTURE_REPO" rev-parse HEAD)

  # Simulate a merge conflict scenario: modify the file after the commit
  # but before revert — git revert with uncommitted changes to the same file
  # would fail with conflicts
  echo "conflicting-change" > "$FIXTURE_REPO/conflict.ts"

  local revalidate_log="$TMPDIR_TEST/revalidate-red.log"
  cat > "$revalidate_log" << 'LOG'
=== pnpm build ===
=== pnpm lint ===
[lint failed]
=== pnpm typecheck ===
=== pnpm test ===
=== pnpm test:bash ===
LOG

  # Should not crash — returns 0 even on revert failure
  run _revert_task_commits "$FIXTURE_REPO" "T5" "$pre_head" "$revalidate_log"
  [ "$status" -eq 0 ]
}