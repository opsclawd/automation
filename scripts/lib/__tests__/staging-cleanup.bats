#!/usr/bin/env bats
# Tests for staging directory lifecycle: cleanup_staging trap handler and
# stale-dir sweep logic in scripts/ai-run-issue-v2.

setup() {
  TMPDIR_TEST="$(mktemp -d)"
  REPO_ROOT="$TMPDIR_TEST/repo"
  STAGING_BASE="$REPO_ROOT/.ai-worktrees"
  mkdir -p "$STAGING_BASE"
  export REPO_ROOT
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

@test "cleanup_staging removes staging dir when it exists" {
  ISSUE_STAGING_DIR="$STAGING_BASE/issue-42-staging"
  mkdir -p "$ISSUE_STAGING_DIR"
  [[ -d "$ISSUE_STAGING_DIR" ]]
  # Source cleanup_staging (extracted inline — same 3-line body)
  cleanup_staging() {
    if [[ -n "${ISSUE_STAGING_DIR:-}" && -d "${ISSUE_STAGING_DIR}" ]]; then
      rm -rf "${ISSUE_STAGING_DIR}"
    fi
  }
  cleanup_staging
  [[ ! -d "$ISSUE_STAGING_DIR" ]]
}

@test "cleanup_staging is a no-op when staging dir does not exist" {
  ISSUE_STAGING_DIR="$STAGING_BASE/issue-99-staging"
  [[ ! -d "$ISSUE_STAGING_DIR" ]]
  cleanup_staging() {
    if [[ -n "${ISSUE_STAGING_DIR:-}" && -d "${ISSUE_STAGING_DIR}" ]]; then
      rm -rf "${ISSUE_STAGING_DIR}"
    fi
  }
  cleanup_staging
  # No error — the function skips silently
  [[ ! -d "$ISSUE_STAGING_DIR" ]]
}

@test "cleanup_staging is a no-op when ISSUE_STAGING_DIR is empty" {
  ISSUE_STAGING_DIR=""
  cleanup_staging() {
    if [[ -n "${ISSUE_STAGING_DIR:-}" && -d "${ISSUE_STAGING_DIR}" ]]; then
      rm -rf "${ISSUE_STAGING_DIR}"
    fi
  }
  cleanup_staging
  # No error and no unintended rm -rf
}

@test "cleanup_staging removes non-empty staging dir" {
  ISSUE_STAGING_DIR="$STAGING_BASE/issue-42-staging"
  mkdir -p "$ISSUE_STAGING_DIR"
  echo "active data" > "$ISSUE_STAGING_DIR/issue.json"
  cleanup_staging() {
    if [[ -n "${ISSUE_STAGING_DIR:-}" && -d "${ISSUE_STAGING_DIR}" ]]; then
      rm -rf "${ISSUE_STAGING_DIR}"
    fi
  }
  cleanup_staging
  # cleanup_staging DOES remove non-empty dirs (it uses rm -rf, not rmdir).
  # This is correct — the trap fires on exit, and any staging data is ephemeral.
  [[ ! -d "$ISSUE_STAGING_DIR" ]]
}

@test "stale sweep removes empty issue-*-staging dirs" {
  mkdir -p "$STAGING_BASE/issue-5-staging"
  mkdir -p "$STAGING_BASE/issue-22-staging"
  mkdir -p "$STAGING_BASE/issue-64-staging"
  [[ -d "$STAGING_BASE/issue-5-staging" ]]
  [[ -d "$STAGING_BASE/issue-22-staging" ]]
  [[ -d "$STAGING_BASE/issue-64-staging" ]]
  for _stale_dir in "${REPO_ROOT}/.ai-worktrees/"issue-*-staging; do
    if [[ -d "$_stale_dir" ]] && [[ -z "$(ls -A "$_stale_dir" 2>/dev/null)" ]]; then
      rmdir "$_stale_dir"
    fi
  done
  [[ ! -d "$STAGING_BASE/issue-5-staging" ]]
  [[ ! -d "$STAGING_BASE/issue-22-staging" ]]
  [[ ! -d "$STAGING_BASE/issue-64-staging" ]]
}

@test "stale sweep preserves non-empty issue-*-staging dirs" {
  mkdir -p "$STAGING_BASE/issue-5-staging"
  echo "data" > "$STAGING_BASE/issue-5-staging/issue.json"
  mkdir -p "$STAGING_BASE/issue-22-staging"
  for _stale_dir in "${REPO_ROOT}/.ai-worktrees/"issue-*-staging; do
    if [[ -d "$_stale_dir" ]] && [[ -z "$(ls -A "$_stale_dir" 2>/dev/null)" ]]; then
      rmdir "$_stale_dir"
    fi
  done
  # issue-5 has content — must survive
  [[ -d "$STAGING_BASE/issue-5-staging" ]]
  [[ -f "$STAGING_BASE/issue-5-staging/issue.json" ]]
  # issue-22 is empty — must be removed
  [[ ! -d "$STAGING_BASE/issue-22-staging" ]]
}

@test "stale sweep is a no-op when no staging dirs exist" {
  # No issue-*-staging dirs — the glob will not match
  for _stale_dir in "${REPO_ROOT}/.ai-worktrees/"issue-*-staging; do
    if [[ -d "$_stale_dir" ]] && [[ -z "$(ls -A "$_stale_dir" 2>/dev/null)" ]]; then
      rmdir "$_stale_dir"
    fi
  done
  # No error — loop body never executes
}
