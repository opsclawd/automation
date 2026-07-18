#!/usr/bin/env bats

# Tests for the sourceable functions in scripts/preflight.sh:
#  - preflight_check_repo: clean/branch/fast-forward gate for a checkout.
#  - preflight_target_repos: resolution of which target repos to check
#    (explicit --target-repo-root vs enabled registered repos in the DB).
#
# preflight.sh returns early when sourced, so sourcing it here only defines
# the functions — none of the process-killing or /tmp-sweeping side effects
# run. All git operations target throwaway fixture repos under TMPDIR_TEST.

setup() {
  TMPDIR_TEST="$(mktemp -d)"

  # shellcheck source=../../preflight.sh
  source "${BATS_TEST_DIRNAME}/../../preflight.sh"

  # Bare origin + working clone on branch main with one commit.
  ORIGIN_BARE="$TMPDIR_TEST/origin.git"
  git init -q --bare -b main "$ORIGIN_BARE"
  TARGET_REPO="$TMPDIR_TEST/target"
  mkdir -p "$TARGET_REPO"
  git -C "$TARGET_REPO" init -q -b main
  git -C "$TARGET_REPO" config user.email "test@example.com"
  git -C "$TARGET_REPO" config user.name "test"
  echo one > "$TARGET_REPO/file.txt"
  git -C "$TARGET_REPO" add file.txt
  git -C "$TARGET_REPO" commit -q -m "init"
  git -C "$TARGET_REPO" remote add origin "$ORIGIN_BARE"
  git -C "$TARGET_REPO" push -q -u origin main 2>/dev/null
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

# Push a new commit to the bare origin from a scratch clone, without
# touching TARGET_REPO's working tree.
push_commit_to_origin() {
  local scratch="$TMPDIR_TEST/scratch"
  rm -rf "$scratch"
  git clone -q "$ORIGIN_BARE" "$scratch"
  git -C "$scratch" config user.email "test@example.com"
  git -C "$scratch" config user.name "test"
  echo more >> "$scratch/file.txt"
  git -C "$scratch" commit -qam "remote change"
  git -C "$scratch" push -q origin main
}

@test "check_repo passes on a clean up-to-date repo" {
  run preflight_check_repo "$TARGET_REPO" main strict
  [ "$status" -eq 0 ]
}

@test "check_repo strict mode fails on untracked files" {
  touch "$TARGET_REPO/stray.txt"
  run preflight_check_repo "$TARGET_REPO" main strict
  [ "$status" -ne 0 ]
  [[ "$output" == *"uncommitted changes"* ]]
}

@test "check_repo ignore mode tolerates untracked orchestrator state dirs" {
  mkdir -p "$TARGET_REPO/.ai-runs" "$TARGET_REPO/.ai-tmp"
  touch "$TARGET_REPO/.ai-runs/orchestrator.sqlite"
  run preflight_check_repo "$TARGET_REPO" main ignore
  [ "$status" -eq 0 ]
}

@test "check_repo ignore mode still fails on tracked modifications" {
  echo dirty >> "$TARGET_REPO/file.txt"
  run preflight_check_repo "$TARGET_REPO" main ignore
  [ "$status" -ne 0 ]
  [[ "$output" == *"uncommitted changes"* ]]
}

@test "check_repo switches back to the expected branch" {
  git -C "$TARGET_REPO" checkout -qb feature
  run preflight_check_repo "$TARGET_REPO" main strict
  [ "$status" -eq 0 ]
  [ "$(git -C "$TARGET_REPO" rev-parse --abbrev-ref HEAD)" = "main" ]
}

@test "check_repo fast-forwards a repo behind origin" {
  push_commit_to_origin
  run preflight_check_repo "$TARGET_REPO" main strict
  [ "$status" -eq 0 ]
  [ "$(git -C "$TARGET_REPO" rev-parse main)" = "$(git -C "$TARGET_REPO" rev-parse origin/main)" ]
}

@test "check_repo fails when local branch diverged from origin" {
  push_commit_to_origin
  echo local-change > "$TARGET_REPO/local.txt"
  git -C "$TARGET_REPO" add local.txt
  git -C "$TARGET_REPO" commit -q -m "local divergence"
  run preflight_check_repo "$TARGET_REPO" main strict
  [ "$status" -ne 0 ]
  [[ "$output" == *"diverged"* ]]
}

@test "check_repo honors a non-main default branch" {
  git -C "$TARGET_REPO" branch -q -m main trunk
  git -C "$TARGET_REPO" push -q -u origin trunk 2>/dev/null
  run preflight_check_repo "$TARGET_REPO" trunk strict
  [ "$status" -eq 0 ]
}

@test "target_repos prefers explicit --target-repo-root argument" {
  run preflight_target_repos "/nonexistent/db.sqlite" --issue 58 --target-repo-root /some/path
  [ "$status" -eq 0 ]
  [ "$output" = "/some/path|" ]
}

@test "target_repos parses --target-repo-root=path form" {
  run preflight_target_repos "/nonexistent/db.sqlite" --target-repo-root=/other/path --issue 58
  [ "$status" -eq 0 ]
  [ "$output" = "/other/path|" ]
}

@test "target_repos reads enabled registered repos from the control-plane DB" {
  command -v sqlite3 >/dev/null 2>&1 || skip "sqlite3 not installed"
  local db="$TMPDIR_TEST/orchestrator.sqlite"
  sqlite3 "$db" "CREATE TABLE repositories (local_base_path TEXT, default_branch TEXT, enabled INTEGER);"
  sqlite3 "$db" "INSERT INTO repositories VALUES ('/repo/a', 'main', 1), ('/repo/b', 'trunk', 1), ('/repo/off', 'main', 0);"
  run preflight_target_repos "$db" --issue 58
  [ "$status" -eq 0 ]
  [[ "$output" == *"/repo/a|main"* ]]
  [[ "$output" == *"/repo/b|trunk"* ]]
  [[ "$output" != *"/repo/off"* ]]
}

@test "target_repos emits nothing when DB is absent and no flag given" {
  run preflight_target_repos "/nonexistent/db.sqlite" --issue 58
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}
