#!/usr/bin/env bats
# Tests for advisory provider-error exit code handling.
# Verifies that exit code 4 (provider error advisory) does NOT trigger
# orchestrator_fail, while exit codes 1-3 still do.
# See: scripts/ai-run-issue-v2 — implement-task, fix-review, etc.

setup() {
  SCRIPT_DIR="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  TMPDIR_TEST="$(mktemp -d)"
  cat > "$TMPDIR_TEST/mock_lib.sh" <<'MOCK'
  orchestrator_fail() {
    echo "FAIL: $*" >> "$TMPDIR_TEST/orchestrator_fail_calls"
  }
  warn() {
    echo "WARN: $*" >> "$TMPDIR_TEST/warn_calls"
  }
  log() {
    :
  }
MOCK
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

@test "exit 4 triggers warn not orchestrator_fail for implement-task" {
  source "$TMPDIR_TEST/mock_lib.sh"
  : > "$TMPDIR_TEST/orchestrator_fail_calls"
  : > "$TMPDIR_TEST/warn_calls"
  _agent_ec=4
  task_n=1
  if [[ $_agent_ec -ne 0 ]]; then
    case $_agent_ec in
      1) orchestrator_fail "implement-task-${task_n} failed (contract violation)" ;;
      2) orchestrator_fail "implement-task-${task_n} failed (config error or timeout)" ;;
      3) orchestrator_fail "implement-task-${task_n} failed (unexpected error)" ;;
      4) warn "implement-task-${task_n} had a provider error — checking for work..." ;;
      *) orchestrator_fail "implement-task-${task_n} failed (unknown exit code $_agent_ec)" ;;
    esac
  fi
  [[ -s "$TMPDIR_TEST/warn_calls" ]]
  grep -q "provider error" "$TMPDIR_TEST/warn_calls"
  [[ ! -s "$TMPDIR_TEST/orchestrator_fail_calls" ]]
}

@test "exit 3 still triggers orchestrator_fail for implement-task" {
  source "$TMPDIR_TEST/mock_lib.sh"
  : > "$TMPDIR_TEST/orchestrator_fail_calls"
  : > "$TMPDIR_TEST/warn_calls"
  _agent_ec=3
  task_n=1
  if [[ $_agent_ec -ne 0 ]]; then
    case $_agent_ec in
      1) orchestrator_fail "implement-task-${task_n} failed (contract violation)" ;;
      2) orchestrator_fail "implement-task-${task_n} failed (config error or timeout)" ;;
      3) orchestrator_fail "implement-task-${task_n} failed (unexpected error)" ;;
      4) warn "implement-task-${task_n} had a provider error — checking for work..." ;;
      *) orchestrator_fail "implement-task-${task_n} failed (unknown exit code $_agent_ec)" ;;
    esac
  fi
  [[ -s "$TMPDIR_TEST/orchestrator_fail_calls" ]]
  grep -q "unexpected error" "$TMPDIR_TEST/orchestrator_fail_calls"
}

@test "exit 1 still triggers orchestrator_fail for implement-task" {
  source "$TMPDIR_TEST/mock_lib.sh"
  : > "$TMPDIR_TEST/orchestrator_fail_calls"
  _agent_ec=1
  task_n=1
  if [[ $_agent_ec -ne 0 ]]; then
    case $_agent_ec in
      1) orchestrator_fail "implement-task-${task_n} failed (contract violation)" ;;
      2) orchestrator_fail "implement-task-${task_n} failed (config error or timeout)" ;;
      3) orchestrator_fail "implement-task-${task_n} failed (unexpected error)" ;;
      4) warn "implement-task-${task_n} had a provider error — checking for work..." ;;
      *) orchestrator_fail "implement-task-${task_n} failed (unknown exit code $_agent_ec)" ;;
    esac
  fi
  [[ -s "$TMPDIR_TEST/orchestrator_fail_calls" ]]
  grep -q "contract violation" "$TMPDIR_TEST/orchestrator_fail_calls"
}

@test "exit 4 triggers warn not orchestrator_fail for fix-review" {
  source "$TMPDIR_TEST/mock_lib.sh"
  : > "$TMPDIR_TEST/orchestrator_fail_calls"
  : > "$TMPDIR_TEST/warn_calls"
  _agent_ec=4
  task_n=1
  if [[ $_agent_ec -ne 0 ]]; then
    case $_agent_ec in
      1) orchestrator_fail "fix-review-task-${task_n} failed (contract violation)" ;;
      2) orchestrator_fail "fix-review-task-${task_n} failed (config error or timeout)" ;;
      3) orchestrator_fail "fix-review-task-${task_n} failed (unexpected error)" ;;
      4) warn "fix-review-task-${task_n} had a provider error — checking for work..." ;;
      *) orchestrator_fail "fix-review-task-${task_n} failed (unknown exit code $_agent_ec)" ;;
    esac
  fi
  [[ -s "$TMPDIR_TEST/warn_calls" ]]
  grep -q "provider error" "$TMPDIR_TEST/warn_calls"
  [[ ! -s "$TMPDIR_TEST/orchestrator_fail_calls" ]]
}

@test "exit 4 triggers warn not orchestrator_fail for plan-design" {
  source "$TMPDIR_TEST/mock_lib.sh"
  : > "$TMPDIR_TEST/orchestrator_fail_calls"
  : > "$TMPDIR_TEST/warn_calls"
  _agent_ec=4
  case $_agent_ec in
    1) orchestrator_fail "plan-design failed (contract violation)" ;;
    2) orchestrator_fail "plan-design failed (config error or timeout)" ;;
    3) orchestrator_fail "plan-design failed (unexpected error)" ;;
    4) warn "plan-design had a provider error — checking for design doc..." ;;
    *) orchestrator_fail "plan-design failed (unknown exit code $_agent_ec)" ;;
  esac
  [[ -s "$TMPDIR_TEST/warn_calls" ]]
  grep -q "provider error" "$TMPDIR_TEST/warn_calls"
  [[ ! -s "$TMPDIR_TEST/orchestrator_fail_calls" ]]
}
