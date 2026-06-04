#!/usr/bin/env bats

# Tests for staging directory lifecycle: cleanup_staging trap handler and
# stale-dir sweep logic in scripts/ai-run-issue-v2.

setup() {
  TMPDIR_TEST="$(mktemp -d)"
  REPO_ROOT="$TMPDIR_TEST/repo"
  STAGING_BASE="$REPO_ROOT/.ai-worktrees"
  mkdir -p "$STAGING_BASE"
  export REPO_ROOT

  # Extract cleanup_staging function from the actual script
  local script_path
  script_path="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/ai-run-issue-v2"
  eval "$(sed -n '/^cleanup_staging()/,/^}/p' "$script_path")"
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

@test "cleanup_staging removes staging dir when it exists" {
  ISSUE_STAGING_DIR="$STAGING_BASE/issue-42-staging"
  mkdir -p "$ISSUE_STAGING_DIR"
  [[ -d "$ISSUE_STAGING_DIR" ]]
  cleanup_staging
  [[ ! -d "$ISSUE_STAGING_DIR" ]]
}

@test "cleanup_staging is a no-op when staging dir does not exist" {
  ISSUE_STAGING_DIR="$STAGING_BASE/issue-99-staging"
  [[ ! -d "$ISSUE_STAGING_DIR" ]]
  cleanup_staging
  # No error — the function skips silently
  [[ ! -d "$ISSUE_STAGING_DIR" ]]
}

@test "cleanup_staging is a no-op when ISSUE_STAGING_DIR is empty" {
  ISSUE_STAGING_DIR=""
  cleanup_staging
  # No error and no unintended rm -rf
}

@test "cleanup_staging removes non-empty staging dir" {
  ISSUE_STAGING_DIR="$STAGING_BASE/issue-42-staging"
  mkdir -p "$ISSUE_STAGING_DIR"
  echo "active data" > "$ISSUE_STAGING_DIR/issue.json"
  cleanup_staging
  # cleanup_staging DOES remove non-empty dirs (it uses rm -rf, not rmdir).
  # This is correct — the trap fires on exit, and any staging data is ephemeral.
  [[ ! -d "$ISSUE_STAGING_DIR" ]]
}

# Helper: run the stale sweep using find -mmin (matches production logic)
run_stale_sweep() {
  while IFS= read -r -d '' _stale_dir; do
    if [[ -z "$(ls -A "$_stale_dir" 2>/dev/null)" ]]; then
      rmdir "$_stale_dir" 2>/dev/null || true
    fi
  done < <(find "$REPO_ROOT/.ai-worktrees" -maxdepth 1 -type d -name 'issue-*-staging' -mmin +5 -print0 2>/dev/null)
}

@test "stale sweep removes empty issue-*-staging dirs older than 5 minutes" {
  mkdir -p "$STAGING_BASE/issue-5-staging"
  mkdir -p "$STAGING_BASE/issue-22-staging"
  mkdir -p "$STAGING_BASE/issue-64-staging"
  # Backdate dirs to simulate they are older than 5 minutes
  touch -d '10 minutes ago' "$STAGING_BASE/issue-5-staging"
  touch -d '10 minutes ago' "$STAGING_BASE/issue-22-staging"
  touch -d '10 minutes ago' "$STAGING_BASE/issue-64-staging"
  run_stale_sweep
  [[ ! -d "$STAGING_BASE/issue-5-staging" ]]
  [[ ! -d "$STAGING_BASE/issue-22-staging" ]]
  [[ ! -d "$STAGING_BASE/issue-64-staging" ]]
}

@test "stale sweep preserves non-empty issue-*-staging dirs older than 5 minutes" {
  mkdir -p "$STAGING_BASE/issue-5-staging"
  echo "data" > "$STAGING_BASE/issue-5-staging/issue.json"
  mkdir -p "$STAGING_BASE/issue-22-staging"
  # Backdate dirs
  touch -d '10 minutes ago' "$STAGING_BASE/issue-5-staging"
  touch -d '10 minutes ago' "$STAGING_BASE/issue-22-staging"
  run_stale_sweep
  # issue-5 has content — must survive
  [[ -d "$STAGING_BASE/issue-5-staging" ]]
  [[ -f "$STAGING_BASE/issue-5-staging/issue.json" ]]
  # issue-22 is empty — must be removed
  [[ ! -d "$STAGING_BASE/issue-22-staging" ]]
}

@test "stale sweep skips recently created empty staging dirs" {
  mkdir -p "$STAGING_BASE/issue-5-staging"
  mkdir -p "$STAGING_BASE/issue-22-staging"
  # issue-5 is recent (just created) — must NOT be swept
  # issue-22 is old — must be swept
  touch -d '10 minutes ago' "$STAGING_BASE/issue-22-staging"
  run_stale_sweep
  # issue-5 is too new — must survive even though empty
  [[ -d "$STAGING_BASE/issue-5-staging" ]]
  # issue-22 is old and empty — must be removed
  [[ ! -d "$STAGING_BASE/issue-22-staging" ]]
}

@test "stale sweep is a no-op when no staging dirs exist" {
  # No issue-*-staging dirs — find returns nothing
  run_stale_sweep
  # No error — loop body never executes
}
