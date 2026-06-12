#!/usr/bin/env bats

setup() {
  SCRIPT_PATH="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/lib/plan-review.sh"

  eval "$(awk '
    /^run_plan_review_loop\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$SCRIPT_PATH")"

  eval "$(awk '
    /^_checksum_file\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$SCRIPT_PATH")"

  eval "$(awk '
    /^_check_review_worktree_violations\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$SCRIPT_PATH")"

  eval "$(awk '
    /^_check_excluded_file_integrity\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$SCRIPT_PATH")"

  eval "$(awk '
    /^parse_review_findings\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$SCRIPT_PATH")"

  eval "$(awk '
    /^_append_known_limitations\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$SCRIPT_PATH")"

  LOG_OUTPUT=""
  log() { LOG_OUTPUT="${LOG_OUTPUT}$*\n"; }
  warn() { log "WARN: $*"; }
  info() { log "INFO: $*"; }
  emit_event() { :; }
  orchestrator_fail() { echo "ORCHESTRATOR_FAIL: $*" >&2; exit 1; }

  TMPDIR_TEST="$(mktemp -d)"
  WORKTREE_DIR="$TMPDIR_TEST"
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

# ── Reviewer retry behavior ────────────────────────────────────────────────

@test "retry: succeeds on first attempt (no retry needed)" {
  run_adversarial_reviewer() {
    echo "## Review Result: PASS" > "${WORKTREE_DIR}/plan-review-findings.md"
    return 0
  }
  run_plan_fixer() { return 0; }
  run run_plan_review_loop "$TMPDIR_TEST" "$TMPDIR_TEST" "run-1" "repo-1" "main" "60" "5" "2"
  [[ $status -eq 0 ]]
}

@test "retry: recovers after one retry when first attempt exits 1" {
  echo 0 > "${TMPDIR_TEST}/.attempt"
  run_adversarial_reviewer() {
    local n
    n=$(< "${TMPDIR_TEST}/.attempt")
    n=$((n + 1))
    echo "$n" > "${TMPDIR_TEST}/.attempt"
    if [[ $n -eq 1 ]]; then
      return 1
    fi
    echo "## Review Result: PASS" > "${WORKTREE_DIR}/plan-review-findings.md"
    return 0
  }
  run_plan_fixer() { return 0; }
  run run_plan_review_loop "$TMPDIR_TEST" "$TMPDIR_TEST" "run-1" "repo-1" "main" "60" "5" "3"
  [[ $status -eq 0 ]]
  [[ $(< "${TMPDIR_TEST}/.attempt") -eq 2 ]]
}

@test "retry: orchestrator_fail after exhausting all retries" {
  echo 0 > "${TMPDIR_TEST}/.attempt"
  run_adversarial_reviewer() {
    local n
    n=$(< "${TMPDIR_TEST}/.attempt")
    n=$((n + 1))
    echo "$n" > "${TMPDIR_TEST}/.attempt"
    return 1
  }
  run_plan_fixer() { return 0; }
  run run_plan_review_loop "$TMPDIR_TEST" "$TMPDIR_TEST" "run-1" "repo-1" "main" "60" "5" "1"
  [[ $status -ne 0 ]]
  # retries=1 means 1 primary + 1 retry = 2 total attempts
  [[ $(< "${TMPDIR_TEST}/.attempt") -eq 2 ]]
}

@test "retry: exit 2 (timeout) is NOT retried" {
  echo 0 > "${TMPDIR_TEST}/.attempt"
  run_adversarial_reviewer() {
    local n
    n=$(< "${TMPDIR_TEST}/.attempt")
    n=$((n + 1))
    echo "$n" > "${TMPDIR_TEST}/.attempt"
    return 2
  }
  run_plan_fixer() { return 0; }
  run run_plan_review_loop "$TMPDIR_TEST" "$TMPDIR_TEST" "run-1" "repo-1" "main" "60" "5" "2"
  [[ $status -ne 0 ]]
  [[ $(< "${TMPDIR_TEST}/.attempt") -eq 1 ]]
}

@test "retry: exit 3 (unexpected error) is NOT retried" {
  echo 0 > "${TMPDIR_TEST}/.attempt"
  run_adversarial_reviewer() {
    local n
    n=$(< "${TMPDIR_TEST}/.attempt")
    n=$((n + 1))
    echo "$n" > "${TMPDIR_TEST}/.attempt"
    return 3
  }
  run_plan_fixer() { return 0; }
  run run_plan_review_loop "$TMPDIR_TEST" "$TMPDIR_TEST" "run-1" "repo-1" "main" "60" "5" "2"
  [[ $status -ne 0 ]]
  [[ $(< "${TMPDIR_TEST}/.attempt") -eq 1 ]]
}

@test "retry: default reviewer_retries is 2 when 8th arg not provided" {
  echo 0 > "${TMPDIR_TEST}/.attempt"
  run_adversarial_reviewer() {
    local n
    n=$(< "${TMPDIR_TEST}/.attempt")
    n=$((n + 1))
    echo "$n" > "${TMPDIR_TEST}/.attempt"
    return 1
  }
  run_plan_fixer() { return 0; }
  # Only 7 args — the 8th defaults to 2
  run run_plan_review_loop "$TMPDIR_TEST" "$TMPDIR_TEST" "run-1" "repo-1" "main" "60" "5"
  [[ $status -ne 0 ]]
  [[ $(< "${TMPDIR_TEST}/.attempt") -eq 3 ]]
}

@test "retry: reviewer failure during retry that is exit 2 causes immediate fail" {
  echo 0 > "${TMPDIR_TEST}/.attempt"
  run_adversarial_reviewer() {
    local n
    n=$(< "${TMPDIR_TEST}/.attempt")
    n=$((n + 1))
    echo "$n" > "${TMPDIR_TEST}/.attempt"
    if [[ $n -eq 1 ]]; then
      return 1  # contract_violation → triggers retry
    fi
    return 2  # timeout on retry → stop retrying, fail
  }
  run_plan_fixer() { return 0; }
  run run_plan_review_loop "$TMPDIR_TEST" "$TMPDIR_TEST" "run-1" "repo-1" "main" "60" "5" "3"
  [[ $status -ne 0 ]]
  [[ $(< "${TMPDIR_TEST}/.attempt") -eq 2 ]]
  [[ "$output" =~ "ORCHESTRATOR_FAIL" ]]
}
