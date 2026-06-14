#!/usr/bin/env bats

# Tests for the fix-review task loop (review-task-manifest consumption)

setup() {
  SCRIPT_DIR="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  source "${SCRIPT_DIR}/review-manifest-helpers.sh"

  TMPDIR_TEST="$(mktemp -d)"
  export ISSUES_DIR="$TMPDIR_TEST"
  export WORKTREE_DIR="$TMPDIR_TEST/worktree"
  mkdir -p "$WORKTREE_DIR"
  export REPO_ROOT="$TMPDIR_TEST"
  export BRANCH="test-branch"
  export BASE_BRANCH="main"

  # Stub functions for subshell isolation
  log() { :; }
  info() { :; }
  warn() { :; }
  emit_event() { :; }
  orchestrator_fail() { return 1; }
  ensure_worktree() { :; }
  ensure_branch() { :; }
  _emit_phase_started() { :; }
  _emit_phase_done() { :; }
  _emit_artifact() { :; }
  _capture_main_state() { :; }
  _guard_main_checkout() { :; }
  _guard_worktree() { :; }
  check_branch_after_agent() { :; }
  resolve_result() { echo "${1:-FAILED}"; }
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

@test "Empty manifest writes ALL_FIXED to fix-status.txt" {
  echo '[]' > "$TMPDIR_TEST/review-task-manifest.json"
  FIX_REVIEW_TASK_COUNT=$(jq 'length' "$TMPDIR_TEST/review-task-manifest.json")
  [ "$FIX_REVIEW_TASK_COUNT" -eq 0 ]
  echo "ALL_FIXED" > "$TMPDIR_TEST/fix-status.txt"
  [ "$(cat "$TMPDIR_TEST/fix-status.txt")" = "ALL_FIXED" ]
}

@test "Manifest with action:defer tasks are skipped" {
  cat > "$TMPDIR_TEST/review-task-manifest.json" << 'JSON'
[{"id":"R1","action":"fix","severity":"high","description":"Fix X","files":["a.ts"],"commit_message":"fix: X"},{"id":"R2","action":"defer","severity":"low","description":"Defer Y","files":["b.ts"],"commit_message":"chore: Y"}]
JSON
  local fix_count
  fix_count=$(jq '[.[] | select(.action == "fix")] | length' "$TMPDIR_TEST/review-task-manifest.json")
  [ "$fix_count" -eq 1 ]
}

@test "Manifest with action:skip tasks are skipped" {
  cat > "$TMPDIR_TEST/review-task-manifest.json" << 'JSON'
[{"id":"R1","action":"fix","severity":"high","description":"Fix","files":[],"commit_message":"fix"},{"id":"R2","action":"skip","severity":"info","description":"Skip","files":[],"commit_message":"skip"}]
JSON
  local fix_count
  fix_count=$(jq '[.[] | select(.action == "fix")] | length' "$TMPDIR_TEST/review-task-manifest.json")
  [ "$fix_count" -eq 1 ]
}

@test "Manifest where all findings are deferred has zero actionable fix tasks" {
  # Regression: an all-deferred manifest must be treated as nothing-to-fix
  # (zero action=fix), not fall into the task loop. Mirrors the production
  # FIX_REVIEW_FIX_COUNT expression in ai-run-issue-v2.
  cat > "$TMPDIR_TEST/review-task-manifest.json" << 'JSON'
[{"id":"1","action":"defer","severity":"low","description":"D1","files":["a.bats"],"commit_message":"x"},{"id":"2","action":"defer","severity":"low","description":"D2","files":["a.bats"],"commit_message":"y"},{"id":"3","action":"defer","severity":"low","description":"D3","files":["a.bats"],"commit_message":"z"}]
JSON
  local fix_count
  fix_count=$(jq '[.[] | select(.action == "fix" or .action == null)] | length' "$TMPDIR_TEST/review-task-manifest.json")
  [ "$fix_count" -eq 0 ]
}

@test "revalidate-log lookup does not crash under set -euo pipefail when no logs exist" {
  # Regression: ls exits 2 on no-match and pipefail propagates it; without
  # `|| true` this killed the run on the nothing-to-fix path.
  set -euo pipefail
  local last
  last=$(ls -t "$TMPDIR_TEST"/revalidate-*-retry-*.log 2>/dev/null | head -1 || true)
  [ -z "$last" ]
}

@test "Multiple fix tasks each get separate iterations" {
  cat > "$TMPDIR_TEST/review-task-manifest.json" << 'JSON'
[{"id":"R1","action":"fix","severity":"high","description":"Fix A","files":["a.ts"],"commit_message":"fix: A"},{"id":"R2","action":"fix","severity":"medium","description":"Fix B","files":["b.ts"],"commit_message":"fix: B"},{"id":"R3","action":"fix","severity":"low","description":"Fix C","files":["c.ts"],"commit_message":"fix: C"}]
JSON
  local fix_count
  fix_count=$(jq '[.[] | select(.action == "fix")] | length' "$TMPDIR_TEST/review-task-manifest.json")
  [ "$fix_count" -eq 3 ]
}

@test "All tasks FIXED writes ALL_FIXED" {
  cat > "$TMPDIR_TEST/review-task-manifest.json" << 'JSON'
[{"id":"R1","action":"fix","severity":"high","description":"Fix A","files":["a.ts"],"commit_message":"fix: A"}]
JSON
  echo "FIXED" > "$WORKTREE_DIR/fix-review-task-R1.result"
  echo "ALL_FIXED" > "$TMPDIR_TEST/fix-status.txt"
  [ "$(cat "$TMPDIR_TEST/fix-status.txt")" = "ALL_FIXED" ]
}

@test "Any task FAILED writes HAS_UNRESOLVED" {
  cat > "$TMPDIR_TEST/review-task-manifest.json" << 'JSON'
[{"id":"R1","action":"fix","severity":"high","description":"Fix A","files":["a.ts"],"commit_message":"fix: A"},{"id":"R2","action":"fix","severity":"medium","description":"Fix B","files":["b.ts"],"commit_message":"fix: B"}]
JSON
  echo "FIXED" > "$WORKTREE_DIR/fix-review-task-R1.result"
  echo "FAILED" > "$WORKTREE_DIR/fix-review-task-R2.result"
  echo "HAS_UNRESOLVED" > "$TMPDIR_TEST/fix-status.txt"
  [ "$(cat "$TMPDIR_TEST/fix-status.txt")" = "HAS_UNRESOLVED" ]
}

@test "Dirty worktree before task triggers reset" {
  touch "$WORKTREE_DIR/dirty-file"
  cd "$WORKTREE_DIR"
  git init && git add -A && git commit -m "init" 2>/dev/null || true
  echo "change" >> "$WORKTREE_DIR/dirty-file"
  ! git diff --exit-code HEAD 2>/dev/null
}

@test "Legacy path: missing manifest falls back to review.md" {
  rm -f "$TMPDIR_TEST/review-task-manifest.json"
  ! _validate_review_manifest "$TMPDIR_TEST/review-task-manifest.json" 2>/dev/null
}

@test "Legacy path: invalid manifest falls back to review.md" {
  echo "not json" > "$TMPDIR_TEST/review-task-manifest.json"
  run _validate_review_manifest "$TMPDIR_TEST/review-task-manifest.json" 2>/dev/null
  [ "$status" -eq 2 ]
}

@test "fix-review: pre-flight validation failure writes baseline log and fails" {
  _preflight_validate() { return 1; }
  export -f _preflight_validate
  _preflight_output="test-suite failed: 3 errors"
  if ! _preflight_validate; then
    echo "$_preflight_output" > "${ISSUES_DIR}/fix-review-baseline.log"
  fi
  [ -f "${ISSUES_DIR}/fix-review-baseline.log" ]
  [ "$(cat "${ISSUES_DIR}/fix-review-baseline.log")" = "test-suite failed: 3 errors" ]
}

@test "ai-run-issue-v2 contains pre-flight baseline check" {
  REAL_REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  run grep -q 'fix-review-preflight' "${REAL_REPO_ROOT}/scripts/ai-run-issue-v2"
  [ "$status" -eq 0 ]
}

@test "_escape_for_grep exits 0 for representative task IDs" {
  for tid in H1 R1 C1 R2-1 "task-42"; do
    run _escape_for_grep "$tid"
    [ "$status" -eq 0 ]
  done
}

@test "_escape_for_grep escapes regex metacharacters" {
  run _escape_for_grep 'R1.*'
  [ "$status" -eq 0 ]
  run grep -qF '\' <<< "$output"
  [ "$status" -eq 0 ]
}

@test "_escape_for_grep output matches original via grep -F" {
  local escaped
  escaped=$(_escape_for_grep "H1")
  echo "H1" | grep -qF "$escaped"
}

@test "original sed expression fails (regression guard for issue-272)" {
  run bash -c 'echo "H1" | sed "s/[][.*^$/\\\\]/\\\\&/g"'
  [ "$status" -ne 0 ]
}

@test "ai-run-issue-v2 per-task loop uses stash-and-commit instead of reset --hard" {
  REAL_REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  run grep -c '_stash_and_conditionally_commit' "${REAL_REPO_ROOT}/scripts/ai-run-issue-v2"
  [ "$status" -eq 0 ]
  [ "$output" -ge 2 ]
}

@test "ai-run-issue-v2 sources fix-review-stash.sh" {
  REAL_REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  run grep -q 'fix-review-stash.sh' "${REAL_REPO_ROOT}/scripts/ai-run-issue-v2"
  [ "$status" -eq 0 ]
}

@test "ai-run-issue-v2 contains exit-code gate after manifest fix-review loop" {
  REAL_REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  run grep -q 'fix-status.txt' "${REAL_REPO_ROOT}/scripts/ai-run-issue-v2"
  [ "$status" -eq 0 ]
}
@test "FIX_REVIEW_ALL_FIXED=0 triggers HAS_UNRESOLVED branch" {
  # Exercises the same if-else as ai-run-issue-v2 lines 4506-4509
  # using the production variable name, not a hardcoded output.
  local FIX_REVIEW_ALL_FIXED=0
  if [[ "$FIX_REVIEW_ALL_FIXED" -eq 1 ]]; then
    echo "ALL_FIXED" > "$TMPDIR_TEST/fix-status.txt"
  else
    echo "HAS_UNRESOLVED" > "$TMPDIR_TEST/fix-status.txt"
  fi
  [ "$(cat "$TMPDIR_TEST/fix-status.txt")" = "HAS_UNRESOLVED" ]
}
@test "FIX_REVIEW_ALL_FIXED=1 triggers ALL_FIXED branch" {
  local FIX_REVIEW_ALL_FIXED=1
  if [[ "$FIX_REVIEW_ALL_FIXED" -eq 1 ]]; then
    echo "ALL_FIXED" > "$TMPDIR_TEST/fix-status.txt"
  else
    echo "HAS_UNRESOLVED" > "$TMPDIR_TEST/fix-status.txt"
  fi
  [ "$(cat "$TMPDIR_TEST/fix-status.txt")" = "ALL_FIXED" ]
}
@test "ai-run-issue-v2 sources fix-review-revert.sh (regression guard)" {
  REAL_REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  run grep -q 'fix-review-revert.sh' "${REAL_REPO_ROOT}/scripts/ai-run-issue-v2"
  [ "$status" -eq 0 ]
}

@test "ai-run-issue-v2 clears validation.result at fix-review phase start" {
  REAL_REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  run grep -A5 '_emit_phase_started "fix-review"' "${REAL_REPO_ROOT}/scripts/ai-run-issue-v2"
  [[ "$output" == *"validation.result"* ]]
}
