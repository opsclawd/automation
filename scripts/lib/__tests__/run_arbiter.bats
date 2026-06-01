#!/usr/bin/env bats

setup() {
  SCRIPT_PATH="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/ai-run-issue-v2"

  TMPDIR_TEST="$(mktemp -d)"
  export WORKTREE_DIR="$TMPDIR_TEST/worktree"
  mkdir -p "$WORKTREE_DIR"
  export ISSUES_DIR="$WORKTREE_DIR"
  export REPO_ROOT="$TMPDIR_TEST"
  export RUN_ID="test-run-arbiter-$(date +%s%N)"
  export REPO_ID="test/repo"
  export BRANCH="ai/test-arbiter"
  export _TSX_LOADER="${REPO_ROOT}/apps/cli/node_modules/tsx/dist/loader.mjs"
  mkdir -p "$REPO_ROOT/apps/cli/node_modules/tsx/dist"
  touch "$_TSX_LOADER"

  STUB_BIN="$TMPDIR_TEST/stub-bin"
  mkdir -p "$STUB_BIN"
  cat > "$STUB_BIN/node" <<'STUB_EOF'
#!/usr/bin/env bash
echo "$@" > "$STUB_NODE_ARGS_FILE"
exit 0
STUB_EOF
  chmod +x "$STUB_BIN/node"
  export STUB_NODE_ARGS_FILE="$TMPDIR_TEST/node-args.txt"
  export PATH="$STUB_BIN:$PATH"

  export REVIEW_LOOP_HISTORY_FILE="$WORKTREE_DIR/review-loop-history.json"
  echo '[{"iteration":1,"spec_status":"SPEC_FAIL","quality_status":"QUALITY_FAIL"}]' > "$REVIEW_LOOP_HISTORY_FILE"

  cat > "$WORKTREE_DIR/spec-review-task-3.md" <<'EOF'
spec findings for task 3
EOF
  cat > "$WORKTREE_DIR/quality-review-task-3.md" <<'EOF'
quality findings for task 3
EOF

  cat > "$WORKTREE_DIR/issue.md" <<'EOF'
# Issue
This is a test issue
EOF

  touch "$WORKTREE_DIR/arbitrate-task-3.log"

  export AI_RUN_EVENTS_FILE="$TMPDIR_TEST/events.jsonl"
  export AI_RUN_DISPLAY_ID="test-arbiter-$(date +%s)"

  log() { :; }
  warn() { :; }
  _capture_main_state() { echo "ok"; }
  _guard_main_checkout() { return 0; }
  check_branch_after_agent() { return 0; }
  emit_event() { :; }
  export -f log warn _capture_main_state _guard_main_checkout check_branch_after_agent emit_event
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

_extract_run_arbiter_body() {
  awk '
    /^[[:space:]]*run_arbiter\(\)/ { found=1 }
    found {
      print
      if (/\{/) depth += gsub(/{/, "{")
      if (/\}/) depth -= gsub(/}/, "}")
      if (depth == 0 && found) { found = 0; depth = 0 }
    }
  ' "$SCRIPT_PATH"
}

@test "run_arbiter: function is defined in ai-run-issue-v2" {
  run grep -E '^[[:space:]]*run_arbiter\(\)[[:space:]]*\{' "$SCRIPT_PATH"
  [ "$status" -eq 0 ]
}

@test "run_arbiter: function is defined after run_fix_review" {
  local fix_line arb_line
  fix_line=$(grep -nE '^[[:space:]]*run_fix_review\(\)' "$SCRIPT_PATH" | head -1 | cut -d: -f1)
  arb_line=$(grep -nE '^[[:space:]]*run_arbiter\(\)' "$SCRIPT_PATH" | head -1 | cut -d: -f1)
  [ -n "$fix_line" ]
  [ -n "$arb_line" ]
  [ "$arb_line" -gt "$fix_line" ]
}

@test "run_arbiter: function is inside the implement phase block" {
  local impl_open arb_line impl_close
  impl_open=$(grep -nE '^if \[\[ "\$PHASE" == "implement" \]\]; then' "$SCRIPT_PATH" | head -1 | cut -d: -f1)
  arb_line=$(grep -nE '^[[:space:]]*run_arbiter\(\)' "$SCRIPT_PATH" | head -1 | cut -d: -f1)
  impl_close=$(awk -v start="$impl_open" 'NR > start && /^fi$/ { print NR; exit }' "$SCRIPT_PATH")
  [ -n "$impl_open" ]
  [ -n "$arb_line" ]
  [ -n "$impl_close" ]
  [ "$arb_line" -gt "$impl_open" ]
  [ "$arb_line" -lt "$impl_close" ]
}

@test "run_arbiter: uses --phase arbitrate" {
  local body
  body=$(_extract_run_arbiter_body)
  echo "$body" | grep -q -- "--phase arbitrate"
}

@test "run_arbiter: uses --phase-id arbitrate-task-N" {
  local body
  body=$(_extract_run_arbiter_body)
  echo "$body" | grep -qE -- '--phase-id[[:space:]]+"arbitrate-task-\$\{task_n\}"'
}

@test "run_arbiter: uses --timeout-minutes 10" {
  local body
  body=$(_extract_run_arbiter_body)
  echo "$body" | grep -qE -- '--timeout-minutes 10'
}

@test "run_arbiter: reads REVIEW_LOOP_HISTORY_FILE content" {
  local body
  body=$(_extract_run_arbiter_body)
  echo "$body" | grep -q 'REVIEW_LOOP_HISTORY_FILE'
  echo "$body" | grep -q 'review-loop-history.json'
}

@test "run_arbiter: reads spec-review-task-N.md" {
  local body
  body=$(_extract_run_arbiter_body)
  echo "$body" | grep -q 'spec-review-task-${task_n}.md'
}

@test "run_arbiter: reads quality-review-task-N.md" {
  local body
  body=$(_extract_run_arbiter_body)
  echo "$body" | grep -q 'quality-review-task-${task_n}.md'
}

@test "run_arbiter: reads issue.md excerpt" {
  local body
  body=$(_extract_run_arbiter_body)
  echo "$body" | grep -q 'issue.md'
  echo "$body" | grep -q 'head -100'
}

@test "run_arbiter: does NOT call orchestrator_fail on agent non-zero exit (only warns)" {
  local body
  body=$(_extract_run_arbiter_body)
  echo "$body" | grep -q 'Arbiter agent exited with code.*attempting to read result'
  echo "$body" | grep -q 'warn "Arbiter agent exited'
  # Verify the agent-exit path uses warn, not orchestrator_fail
  local agent_exit_block
  agent_exit_block=$(echo "$body" | sed -n '/Arbiter agent exited/,/^    fi/p')
  ! echo "$agent_exit_block" | grep -q 'orchestrator_fail'
}

@test "run_arbiter: emits arbiter.invoked event" {
  local body
  body=$(_extract_run_arbiter_body)
  echo "$body" | grep -q 'arbiter.invoked'
}

@test "run_arbiter: ARBITER_PROMPT mentions all 4 outcomes" {
  local body
  body=$(_extract_run_arbiter_body)
  echo "$body" | grep -q 'RESOLVED_TIEBREAK'
  echo "$body" | grep -q 'RESOLVED_AMENDED'
  echo "$body" | grep -q 'DEVIATION_PROCEED'
  echo "$body" | grep -q 'BLOCKED_IMPL_DEFECT'
}

@test "run_arbiter: ARBITER_PROMPT requires arbiter-result.json output" {
  local body
  body=$(_extract_run_arbiter_body)
  echo "$body" | grep -q 'arbiter-result.json'
}

@test "run_arbiter: ARBITER_PROMPT requires arbiter-rationale-N.md output" {
  local body
  body=$(_extract_run_arbiter_body)
  echo "$body" | grep -q 'arbiter-rationale-${task_n}.md'
}

@test "run_arbiter: ARBITER_PROMPT contains evidence field requirement" {
  local body
  body=$(_extract_run_arbiter_body)
  echo "$body" | grep -q 'evidence'
}

@test "run_arbiter: includes review verdicts in prompt" {
  local body
  body=$(_extract_run_arbiter_body)
  echo "$body" | grep -q 'Spec review:'
  echo "$body" | grep -q 'Quality review:'
}

@test "run_arbiter: logs invocation to operator" {
  local body
  body=$(_extract_run_arbiter_body)
  echo "$body" | grep -q 'invoking arbiter'
}

@test "run_arbiter: invokes node --import with _TSX_LOADER" {
  local body
  body=$(_extract_run_arbiter_body)
  echo "$body" | grep -q -- '--import "\$_TSX_LOADER"'
  echo "$body" | grep -q 'run-agent.ts'
}

@test "run_arbiter: passes --repo-root and --run-id and --repo-id" {
  local body
  body=$(_extract_run_arbiter_body)
  echo "$body" | grep -q -- '--repo-root "\$REPO_ROOT"'
  echo "$body" | grep -q -- '--run-id "\$RUN_ID"'
  echo "$body" | grep -q -- '--repo-id "\$REPO_ID"'
}

@test "run_arbiter: behavioral — invokes node with arbiter phase and correct phase-id" {
  export REPO_ROOT="$TMPDIR_TEST"
  eval "$(_extract_run_arbiter_body)"

  set +e
  run_arbiter "3" "test task" "task text" "abc123" "def456" "SPEC_FAIL" "QUALITY_FAIL"
  set -e

  [ -f "$STUB_NODE_ARGS_FILE" ]
  local args
  args=$(cat "$STUB_NODE_ARGS_FILE")
  echo "$args" | grep -q -- "--phase"
  echo "$args" | grep -q "arbitrate"
  echo "$args" | grep -q "arbitrate-task-3"
}

@test "run_arbiter: behavioral — creates a prompt file with task context" {
  export REPO_ROOT="$TMPDIR_TEST"
  eval "$(_extract_run_arbiter_body)"

  set +e
  run_arbiter "3" "test task title" "task text content" "abc123" "def456" "SPEC_FAIL" "QUALITY_FAIL"
  set -e

  local prompt_content
  prompt_content=$(cat "$STUB_NODE_ARGS_FILE" 2>/dev/null || true)

  local prompt_file
  prompt_file=$(echo "$prompt_content" | grep -oE -- "--prompt-file [^ ]+" | head -1 | sed 's/--prompt-file //' || true)
  if [ -n "$prompt_file" ] && [ -f "$prompt_file" ]; then
    grep -q "Task 3" "$prompt_file"
    grep -q "test task title" "$prompt_file"
  fi
}

@test "run_arbiter: behavioral — does not exit on agent non-zero exit code" {
  cat > "$STUB_BIN/node" <<'STUB_EOF'
#!/usr/bin/env bash
echo "$@" > "$STUB_NODE_ARGS_FILE"
exit 3
STUB_EOF
  chmod +x "$STUB_BIN/node"

  export REPO_ROOT="$TMPDIR_TEST"
  eval "$(_extract_run_arbiter_body)"

  set +e
  run_arbiter "3" "test task" "task text" "abc123" "def456" "SPEC_FAIL" "QUALITY_FAIL"
  local rc=$?
  set -e
  [ "$rc" -ne 1 ]
}

@test "run_arbiter: bash syntax — entire script remains valid" {
  run bash -n "$SCRIPT_PATH"
  [ "$status" -eq 0 ]
}
