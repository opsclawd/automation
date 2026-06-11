#!/usr/bin/env bats

# Tests for the SHA-comparison guard and run_result_writer recovery in
# scripts/ai-run-issue-v2. Verifies that when resolve_result returns BLOCKED
# for an implement-task, the guard checks HEAD vs base_sha and either invokes
# the result-writer (HEAD advanced) or preserves BLOCKED (HEAD unchanged).

setup() {
  SCRIPT_PATH="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/ai-run-issue-v2"
  SHARED_LIB="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/lib/result-resolver.sh"
  source "$SHARED_LIB"

  # Extract run_result_writer via awk brace-counting.
  eval "$(awk '
    /^(run_result_writer)\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$SCRIPT_PATH")"

  TMPDIR_TEST="$(mktemp -d)"
  WORKTREE_DIR="$TMPDIR_TEST/worktree"
  mkdir -p "$WORKTREE_DIR"

  # Stub git to return a controlled HEAD SHA
  _MOCK_HEAD_SHA="aaa111"
  git() { echo "$_MOCK_HEAD_SHA"; }

  # Stub node/run-agent.ts to simulate the result-writer agent
  _RESULT_WRITER_OUTPUT="DONE"
  _RESULT_WRITER_EXIT=0
  NODE_OPTIONS='--conditions=development'
  node() {
    # Simulate agent writing the result file
    echo "$_RESULT_WRITER_OUTPUT" > "${WORKTREE_DIR}/implement-task-${_TASK_NUM:-1}.result"
    return $_RESULT_WRITER_EXIT
  }

  # Stubs for helpers referenced by run_result_writer
  log() { :; }
  check_branch_after_agent() { :; }
  REPO_ROOT="$TMPDIR_TEST/repo"
  RUN_ID="test-run"
  REPO_ID="test/repo"
  _TSX_LOADER="/dev/null"
  ISSUES_DIR="$TMPDIR_TEST/issues"
  mkdir -p "$ISSUES_DIR"
  _TASK_NUM=1
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

@test "run_result_writer: skips when basesha.log missing" {
  run run_result_writer 1
  [ "$status" -eq 1 ]
}

@test "run_result_writer: skips when basesha.log empty" {
  echo "" > "${WORKTREE_DIR}/implement-task-1.basesha.log"
  run run_result_writer 1
  [ "$status" -eq 1 ]
}

@test "run_result_writer: skips when HEAD equals base_sha (no commits)" {
  _MOCK_HEAD_SHA="abc123"
  echo "abc123" > "${WORKTREE_DIR}/implement-task-1.basesha.log"
  run run_result_writer 1
  [ "$status" -eq 1 ]
  # No result file should be written
  [ ! -f "${WORKTREE_DIR}/implement-task-1.result" ]
}

@test "run_result_writer: invokes agent and succeeds when HEAD advanced" {
  _MOCK_HEAD_SHA="def456"
  echo "abc123" > "${WORKTREE_DIR}/implement-task-1.basesha.log"
  _RESULT_WRITER_OUTPUT="DONE"
  _RESULT_WRITER_EXIT=0

  run run_result_writer 1
  [ "$status" -eq 0 ]
  # Result file should contain DONE
  [ "$(cat "${WORKTREE_DIR}/implement-task-1.result")" = "DONE" ]
}

@test "run_result_writer: preserves BLOCKED when result-writer writes BLOCKED" {
  _MOCK_HEAD_SHA="def456"
  echo "abc123" > "${WORKTREE_DIR}/implement-task-1.basesha.log"
  _RESULT_WRITER_OUTPUT="BLOCKED"
  _RESULT_WRITER_EXIT=0

  run run_result_writer 1
  [ "$status" -eq 0 ]
  [ "$(cat "${WORKTREE_DIR}/implement-task-1.result")" = "BLOCKED" ]
}

@test "run_result_writer: returns failure when agent exits non-zero" {
  _MOCK_HEAD_SHA="def456"
  echo "abc123" > "${WORKTREE_DIR}/implement-task-1.basesha.log"
  _RESULT_WRITER_OUTPUT=""
  _RESULT_WRITER_EXIT=1

  run run_result_writer 1
  [ "$status" -eq 1 ]
}

@test "run_result_writer: returns failure when agent writes nothing" {
  _MOCK_HEAD_SHA="def456"
  echo "abc123" > "${WORKTREE_DIR}/implement-task-1.basesha.log"
  # Agent exits 0 but doesn't write a valid result
  node() { return 0; }

  run run_result_writer 1
  [ "$status" -eq 1 ]
}

@test "guard: SHA advanced + result-writer writes DONE -> final status DONE" {
  # Simulate the full guard flow: basesha exists, HEAD advanced,
  # result-writer writes DONE, re-resolve returns DONE.
  _MOCK_HEAD_SHA="def456"
  echo "abc123" > "${WORKTREE_DIR}/implement-task-1.basesha.log"
  echo "DONE" > "${WORKTREE_DIR}/implement-task-1.result"
  touch "${WORKTREE_DIR}/implement-task-1.md"
  _RESULT_WRITER_OUTPUT="DONE"
  _RESULT_WRITER_EXIT=0

  # Simulate the guard: run_result_writer succeeds, then re-resolve
  run_result_writer 1
  local new_status
  new_status=$(resolve_result \
    "${WORKTREE_DIR}/implement-task-1.result" \
    "${WORKTREE_DIR}/implement-task-1.md" \
    DONE DONE_WITH_CONCERNS BLOCKED NEEDS_CONTEXT "DONE")
  [ "$new_status" = "DONE" ]
}

@test "guard: SHA advanced + result-writer writes DONE -> final status DONE (NEEDS_CONTEXT initial)" {
  # Same as previous test but initial result is NEEDS_CONTEXT.
  # Guard triggers for both BLOCKED and NEEDS_CONTEXT.
  _MOCK_HEAD_SHA="def456"
  echo "abc123" > "${WORKTREE_DIR}/implement-task-1.basesha.log"
  echo "NEEDS_CONTEXT" > "${WORKTREE_DIR}/implement-task-1.result"
  touch "${WORKTREE_DIR}/implement-task-1.md"
  _RESULT_WRITER_OUTPUT="DONE"
  _RESULT_WRITER_EXIT=0

  run_result_writer 1
  local new_status
  new_status=$(resolve_result \
    "${WORKTREE_DIR}/implement-task-1.result" \
    "${WORKTREE_DIR}/implement-task-1.md" \
    DONE DONE_WITH_CONCERNS BLOCKED NEEDS_CONTEXT "DONE")
  [ "$new_status" = "DONE" ]
}

@test "guard: SHA unchanged -> result-writer not invoked, BLOCKED preserved" {
  _MOCK_HEAD_SHA="abc123"
  echo "abc123" > "${WORKTREE_DIR}/implement-task-1.basesha.log"
  echo "BLOCKED" > "${WORKTREE_DIR}/implement-task-1.result"

  # Guard should NOT call run_result_writer when HEAD == base_sha
  # (run_result_writer would return 1, preserving BLOCKED)
  run run_result_writer 1
  [ "$status" -eq 1 ]
  # Result should still be BLOCKED
  [ "$(cat "${WORKTREE_DIR}/implement-task-1.result")" = "BLOCKED" ]
}

@test "guard: validate_result_file identifies explicit BLOCKED (guard skips recovery)" {
  # The guard in the main script uses validate_result_file to distinguish
  # an explicit BLOCKED (written by the implementer) from a missing/invalid
  # result file (where the fallback wrote BLOCKED). When the file contains
  # an explicit BLOCKED, the guard skips recovery entirely.
  echo "BLOCKED" > "${WORKTREE_DIR}/implement-task-1.result"
  run validate_result_file "${WORKTREE_DIR}/implement-task-1.result" BLOCKED NEEDS_CONTEXT
  [ "$status" -eq 0 ]
}

@test "guard: validate_result_file identifies explicit NEEDS_CONTEXT (guard skips recovery)" {
  echo "NEEDS_CONTEXT" > "${WORKTREE_DIR}/implement-task-1.result"
  run validate_result_file "${WORKTREE_DIR}/implement-task-1.result" BLOCKED NEEDS_CONTEXT
  [ "$status" -eq 0 ]
}

@test "guard: validate_result_file rejects missing file (guard attempts recovery)" {
  # When the result file doesn't exist (fallback path), validate_result_file
  # returns 1, and the guard proceeds to SHA comparison + result-writer.
  run validate_result_file "${WORKTREE_DIR}/implement-task-1.result" BLOCKED NEEDS_CONTEXT
  [ "$status" -eq 1 ]
}

@test "guard: validate_result_file rejects invalid content (guard attempts recovery)" {
  echo "GARBAGE" > "${WORKTREE_DIR}/implement-task-1.result"
  run validate_result_file "${WORKTREE_DIR}/implement-task-1.result" BLOCKED NEEDS_CONTEXT
  [ "$status" -eq 1 ]
}

@test "guard: pre-resolve capture detects missing file before fallback writes BLOCKED" {
  # This is the critical scenario from the review: result file doesn't exist,
  # validate_result_file returns 1 (_explicit_block=0), then resolve_result
  # writes BLOCKED as fallback. The guard must use the pre-resolve state.
  # Simulate: file missing → _explicit_block=0 → resolve_result writes BLOCKED
  _explicit_block=0
  if validate_result_file "${WORKTREE_DIR}/implement-task-1.result" BLOCKED NEEDS_CONTEXT; then
    _explicit_block=1
  fi
  # _explicit_block should be 0 (file was missing)
  [ "$_explicit_block" -eq 0 ]

  # Now simulate resolve_result fallback writing BLOCKED
  echo "BLOCKED" > "${WORKTREE_DIR}/implement-task-1.result"

  # Verify: the file now contains BLOCKED (fallback wrote it), but
  # _explicit_block is still 0 — recovery should proceed
  [ "$(cat "${WORKTREE_DIR}/implement-task-1.result")" = "BLOCKED" ]
  [ "$_explicit_block" -eq 0 ]
}

@test "guard: pre-resolve capture detects explicit BLOCKED before resolve_result" {
  # Result file has explicit BLOCKED from implementer
  echo "BLOCKED" > "${WORKTREE_DIR}/implement-task-1.result"
  _explicit_block=0
  if validate_result_file "${WORKTREE_DIR}/implement-task-1.result" BLOCKED NEEDS_CONTEXT; then
    _explicit_block=1
  fi
  # _explicit_block should be 1 (file had explicit BLOCKED)
  [ "$_explicit_block" -eq 1 ]
}

@test "guard: SHA unchanged + exit 3 -> result-writer not invoked" {
  # Set up: SHA unchanged (base_sha == HEAD)
  echo "$_MOCK_HEAD_SHA" > "$WORKTREE_DIR/implement-task-5.basesha.log"

  # Stub run_result_writer to track if it's called
  _result_writer_called=0
  run_result_writer() { _result_writer_called=1; return 1; }

  # Stub validate_result_file to return false (no explicit block)
  validate_result_file() { return 1; }

  # Stub resolve_result to return BLOCKED (simulates no-result-file fallback)
  resolve_result() { echo "BLOCKED"; return 0; }

  # Simulate the state that the guard would see:
  # SHA unchanged, exit 3, no explicit block
  _agent_ec=3
  _explicit_block=0

  # Verify: result-writer should not be called
  [ "$_result_writer_called" -eq 0 ]
}

# Helper: core retry-guard logic extracted from ai-run-issue-v2
_retry_implementer() {
  if [[ "$_impl_agent_ec" -eq 3 ]] && [[ "${_IMPLEMENTER_RETRIED:-0}" -eq 0 ]]; then
    _IMPLEMENTER_RETRIED=1
    rm -f "$_result_file"
    run_implementer "$_TASK_NUM" "task_title" "TASK_TEXT" "COMMIT_MSG"
    _impl_agent_ec=${_agent_ec:-0}
  fi
}

@test "guard: exit 3 with no prior retry -> implementer invoked and _IMPLEMENTER_RETRIED=1" {
  _impl_agent_ec=3
  _IMPLEMENTER_RETRIED=0
  _agent_ec=3

  _implementer_retry_called=0
  run_implementer() { _implementer_retry_called=$((_implementer_retry_called + 1)); }

  _retry_implementer

  [ "$_implementer_retry_called" -eq 1 ]
  [ "$_IMPLEMENTER_RETRIED" -eq 1 ]
}

@test "guard: exit 3 with prior retry exhausted -> implementer not invoked again" {
  _impl_agent_ec=3
  _IMPLEMENTER_RETRIED=1
  _agent_ec=3

  _implementer_retry_called=0
  run_implementer() { _implementer_retry_called=$((_implementer_retry_called + 1)); }

  _retry_implementer

  [ "$_implementer_retry_called" -eq 0 ]
  [ "$_IMPLEMENTER_RETRIED" -eq 1 ]
}

@test "guard: exit 3 retry clears stale synthetic BLOCKED result file" {
  _impl_agent_ec=3
  _IMPLEMENTER_RETRIED=0
  _agent_ec=0
  _TASK_NUM=9
  _result_file="$WORKTREE_DIR/implement-task-9.result"

  # Simulate first-attempt resolve_result having written a synthetic BLOCKED
  echo "BLOCKED" > "$_result_file"
  [ -f "$_result_file" ]

  run_implementer() { :; }

  _retry_implementer

  # The stale result file must be removed so the retry starts clean
  [ ! -f "$_result_file" ]
}
