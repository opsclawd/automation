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

@test "cleanup_staging removes staging dir when it exists and owns it" {
  ISSUE_STAGING_DIR="$STAGING_BASE/issue-42-staging"
  mkdir -p "$ISSUE_STAGING_DIR"
  : > "$ISSUE_STAGING_DIR/.owner-${BASHPID}"
  [[ -d "$ISSUE_STAGING_DIR" ]]
  cleanup_staging
  [[ ! -d "$ISSUE_STAGING_DIR" ]]
}

@test "cleanup_staging is a no-op when dir exists but no owner marker" {
  ISSUE_STAGING_DIR="$STAGING_BASE/issue-42-staging"
  mkdir -p "$ISSUE_STAGING_DIR"
  [[ -d "$ISSUE_STAGING_DIR" ]]
  cleanup_staging
  # Dir must survive — no owner marker means we didn't create it
  [[ -d "$ISSUE_STAGING_DIR" ]]
}

@test "cleanup_staging is a no-op when dir is owned by a different PID" {
  ISSUE_STAGING_DIR="$STAGING_BASE/issue-42-staging"
  mkdir -p "$ISSUE_STAGING_DIR"
  : > "$ISSUE_STAGING_DIR/.owner-99999"
  [[ -d "$ISSUE_STAGING_DIR" ]]
  cleanup_staging
  # Dir must survive — owned by a different process
  [[ -d "$ISSUE_STAGING_DIR" ]]
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

@test "cleanup_staging removes non-empty staging dir when owned" {
  ISSUE_STAGING_DIR="$STAGING_BASE/issue-42-staging"
  mkdir -p "$ISSUE_STAGING_DIR"
  : > "$ISSUE_STAGING_DIR/.owner-${BASHPID}"
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
    elif [[ -n "$(find "$_stale_dir" -maxdepth 1 -name '.owner-*' ! -name '.owner-* *' -print 2>/dev/null)" ]]; then
      _all_markers_dead=true
      _dead_markers=()
      for _marker in "$_stale_dir"/.owner-*; do
        [[ -f "$_marker" ]] || continue
        _marker_pid="${_marker##*.owner-}"
        if [[ "$_marker_pid" =~ ^[0-9]+$ ]] && kill -0 "$_marker_pid" 2>/dev/null; then
          _all_markers_dead=false
          break
        fi
        _dead_markers+=("$_marker")
      done
      if $_all_markers_dead; then
        rm -f "${_dead_markers[@]}"
        if [[ -z "$(ls -A "$_stale_dir" 2>/dev/null)" ]]; then
          rmdir "$_stale_dir" 2>/dev/null || true
        fi
      fi
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

@test "stale sweep removes owner-marker-only dir when owning process is dead" {
  mkdir -p "$STAGING_BASE/issue-5-staging"
  : > "$STAGING_BASE/issue-5-staging/.owner-99999"
  touch -d '10 minutes ago' "$STAGING_BASE/issue-5-staging"
  run_stale_sweep
  # Dir had only an owner marker for a dead PID — must be removed
  [[ ! -d "$STAGING_BASE/issue-5-staging" ]]
}

@test "stale sweep removes owner-marker-only dir with multiple dead PIDs" {
  mkdir -p "$STAGING_BASE/issue-5-staging"
  : > "$STAGING_BASE/issue-5-staging/.owner-99998"
  : > "$STAGING_BASE/issue-5-staging/.owner-99999"
  touch -d '10 minutes ago' "$STAGING_BASE/issue-5-staging"
  run_stale_sweep
  # All markers belong to dead PIDs — must be removed
  [[ ! -d "$STAGING_BASE/issue-5-staging" ]]
}

@test "stale sweep preserves owner-marker-only dir when owning process is alive" {
  mkdir -p "$STAGING_BASE/issue-5-staging"
  # Use current shell's PID — it IS alive
  : > "$STAGING_BASE/issue-5-staging/.owner-${BASHPID}"
  touch -d '10 minutes ago' "$STAGING_BASE/issue-5-staging"
  run_stale_sweep
  # Owner marker belongs to a live process — must survive
  [[ -d "$STAGING_BASE/issue-5-staging" ]]
  [[ -f "$STAGING_BASE/issue-5-staging/.owner-${BASHPID}" ]]
}

@test "stale sweep preserves dir with mixed dead and live owner markers" {
  mkdir -p "$STAGING_BASE/issue-5-staging"
  : > "$STAGING_BASE/issue-5-staging/.owner-99999"
  # Current shell's PID — alive
  : > "$STAGING_BASE/issue-5-staging/.owner-${BASHPID}"
  touch -d '10 minutes ago' "$STAGING_BASE/issue-5-staging"
  run_stale_sweep
  # At least one marker belongs to a live process — must survive
  [[ -d "$STAGING_BASE/issue-5-staging" ]]
}

@test "stale sweep preserves dir with owner marker and real content" {
  mkdir -p "$STAGING_BASE/issue-5-staging"
  : > "$STAGING_BASE/issue-5-staging/.owner-99999"
  echo "data" > "$STAGING_BASE/issue-5-staging/issue.json"
  touch -d '10 minutes ago' "$STAGING_BASE/issue-5-staging"
  run_stale_sweep
  # Dir has real content beyond owner markers — must survive
  [[ -d "$STAGING_BASE/issue-5-staging" ]]
  [[ -f "$STAGING_BASE/issue-5-staging/issue.json" ]]
}
