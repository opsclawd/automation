#!/usr/bin/env bats

setup() {
  SCRIPT_PATH="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/lib/plan-review.sh"

  eval "$(awk '
    /^classify_plan_risk\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$SCRIPT_PATH")"

  eval "$(awk '
    /^parse_review_findings\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$SCRIPT_PATH")"

  eval "$(awk '
    /^_check_review_worktree_violations\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$SCRIPT_PATH")"

  eval "$(awk '
    /^escalate_plan_review\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$SCRIPT_PATH")"

  eval "$(awk '
    /^run_plan_review_loop\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$SCRIPT_PATH")"

  LOG_OUTPUT=""
  log() { LOG_OUTPUT="${LOG_OUTPUT}$*\n"; }
  warn() { log "WARN: $*"; }
  info() { log "INFO: $*"; }
  emit_event() { :; }
  orchestrator_fail() { echo "ORCHESTRATOR_FAIL: $*" >&2; exit 1; }

  # Stub external commands
  _GH_OUTPUT=""
  gh() { echo "${_GH_OUTPUT:-ok}"; }
  _NODE_ECS=0
  node() { return ${_NODE_ECS}; }
  _GIT_SHA="abc123"
  _DIFF_FILES=""
  _LS_FILES=""
  git() {
    case "$*" in
      *"--name-only"*) echo "$_DIFF_FILES";;
      *"--others"*"--exclude-standard"*) echo "$_LS_FILES";;
      *"rev-parse HEAD"*) echo "$_GIT_SHA";;
      *) ;;
    esac
  }

  TMPDIR_TEST="$(mktemp -d)"
  WORKTREE_DIR="$TMPDIR_TEST"
  REPO_ROOT="$TMPDIR_TEST"
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

# ── classify_plan_risk ──────────────────────────────────────────────────────

@test "classify_plan_risk: returns 0 when sentinel is present" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
<!-- plan-review-required -->
# My Plan
Some plan content.
PLAN
  classify_plan_risk "$TMPDIR_TEST"
}

@test "classify_plan_risk: returns 1 when sentinel is absent" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
# Simple Plan
Just a CRUD adapter.
PLAN
  run classify_plan_risk "$TMPDIR_TEST"
  [[ $status -ne 0 ]]
}

@test "classify_plan_risk: returns 1 when plan.md is missing" {
  run classify_plan_risk "$TMPDIR_TEST"
  [[ $status -ne 0 ]]
}

@test "classify_plan_risk: returns 0 when sentinel is embedded in content" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
# Complex Plan

Some intro text.

<!-- plan-review-required -->

## Task 1: Implement retry logic
PLAN
  classify_plan_risk "$TMPDIR_TEST"
}

# ── parse_review_findings ───────────────────────────────────────────────────

@test "parse_review_findings: returns PASS when no findings file" {
  run parse_review_findings "$TMPDIR_TEST"
  [[ "$output" == "PASS" ]]
}

@test "parse_review_findings: returns PASS when findings say PASS" {
  cat > "$TMPDIR_TEST/plan-review-findings.md" << 'FINDINGS'
## Review Result: PASS
No P1 or P2 findings.
FINDINGS
  run parse_review_findings "$TMPDIR_TEST"
  [[ "$output" == "PASS" ]]
}

@test "parse_review_findings: returns P1_FOUND when P1 heading present" {
  cat > "$TMPDIR_TEST/plan-review-findings.md" << 'FINDINGS'
## Review Result: FINDINGS

### P1: Retry after irreversible side effect
**Plan text:** > reset on failure
**What actually happens:** reply already posted
FINDINGS
  run parse_review_findings "$TMPDIR_TEST"
  [[ "$output" == "P1_FOUND" ]]
}

@test "parse_review_findings: returns P2_ACKNOWLEDGED when only P2 present" {
  cat > "$TMPDIR_TEST/plan-review-findings.md" << 'FINDINGS'
## Review Result: FINDINGS

### P2: Missing error message for timeout
**Plan text:** > handle timeout
**What is incomplete:** no user-facing message specified
FINDINGS
  run parse_review_findings "$TMPDIR_TEST"
  [[ "$output" == "P2_ACKNOWLEDGED" ]]
}

@test "parse_review_findings: returns P1_FOUND when both P1 and P2 present" {
  cat > "$TMPDIR_TEST/plan-review-findings.md" << 'FINDINGS'
## Review Result: FINDINGS

### P1: Wrong state transition
**Plan text:** > transition to IDLE
**What actually happens:** stays in RUNNING

### P2: Missing logging
**Plan text:** > log the event
**What is incomplete:** log level not specified
FINDINGS
  run parse_review_findings "$TMPDIR_TEST"
  [[ "$output" == "P1_FOUND" ]]
}

@test "parse_review_findings: matches P1 with leading spaces" {
  cat > "$TMPDIR_TEST/plan-review-findings.md" << 'FINDINGS'
## Review Result: FINDINGS

  ### P1: Indented finding
  **Plan text:** > some text
  **What actually happens:** something else
FINDINGS
  run parse_review_findings "$TMPDIR_TEST"
  [[ "$output" == "P1_FOUND" ]]
}

@test "parse_review_findings: matches bold P1 format" {
  cat > "$TMPDIR_TEST/plan-review-findings.md" << 'FINDINGS'
## Review Result: FINDINGS

- **P1** Retry loop mismatch
FINDINGS
  run parse_review_findings "$TMPDIR_TEST"
  [[ "$output" == "P1_FOUND" ]]
}

@test "parse_review_findings: matches severity: P2 format" {
  cat > "$TMPDIR_TEST/plan-review-findings.md" << 'FINDINGS'
## Review Result: FINDINGS

severity: P2 — minor issue
FINDINGS
  run parse_review_findings "$TMPDIR_TEST"
  [[ "$output" == "P2_ACKNOWLEDGED" ]]
}

# ── _check_review_worktree_violations ────────────────────────────────────────

@test "_check_review_worktree_violations: passes when no violations" {
  _DIFF_FILES=""
  _LS_FILES=""
  run _check_review_worktree_violations "$TMPDIR_TEST"
  [[ $status -eq 0 ]]
}

@test "_check_review_worktree_violations: passes for allowed files" {
  _DIFF_FILES="plan.md"
  _LS_FILES=""
  run _check_review_worktree_violations "$TMPDIR_TEST"
  [[ $status -eq 0 ]]
}

@test "_check_review_worktree_violations: fails for source file modifications" {
  _DIFF_FILES="src/index.ts"
  _LS_FILES=""
  run _check_review_worktree_violations "$TMPDIR_TEST"
  [[ $status -ne 0 ]]
}

# ── escalate_plan_review ────────────────────────────────────────────────────

@test "escalate_plan_review: posts comment and adds label" {
  _GH_OUTPUT=""
  cat > "$TMPDIR_TEST/plan-review-findings.md" << 'FINDINGS'
### P1: Some finding
FINDINGS
  run escalate_plan_review "$TMPDIR_TEST" "123" "5"
  [[ $status -ne 0 ]]
}

# ── run_plan_review_loop ────────────────────────────────────────────────────

@test "run_plan_review_loop: returns 0 when plan passes on first iteration" {
  cat > "$TMPDIR_TEST/plan-review-findings.md" << 'FINDINGS'
## Review Result: PASS
No P1 or P2 findings.
FINDINGS

  run_adversarial_reviewer() { return 0; }
  run_plan_fixer() { return 0; }

  run run_plan_review_loop "$TMPDIR_TEST" "$TMPDIR_TEST" "run-1" "repo-1" "main" "60" "5"
  [[ $status -eq 0 ]]
}

@test "run_plan_review_loop: orchestrator_fail on reviewer failure" {
  run_adversarial_reviewer() { return 1; }
  run_plan_fixer() { return 0; }

  run run_plan_review_loop "$TMPDIR_TEST" "$TMPDIR_TEST" "run-1" "repo-1" "main" "60" "5"
  [[ $status -ne 0 ]]
}

@test "run_plan_review_loop: orchestrator_fail on fixer failure" {
  _apply_fixer() {
    echo "## Review Result: PASS" > "${WORKTREE_DIR}/plan-review-findings.md"
  }
  run_adversarial_reviewer() {
    echo "### P1: Something" > "${WORKTREE_DIR}/plan-review-findings.md"
    return 0
  }
  run_plan_fixer() { return 1; }

  run run_plan_review_loop "$TMPDIR_TEST" "$TMPDIR_TEST" "run-1" "repo-1" "main" "60" "5"
  [[ $status -ne 0 ]]
}

@test "run_plan_review_loop: orchestrator_fail when findings file missing after reviewer" {
  run_adversarial_reviewer() {
    # Agent succeeds but doesn't write findings file
    return 0
  }
  run_plan_fixer() { return 0; }

  # Remove any existing findings file
  rm -f "$TMPDIR_TEST/plan-review-findings.md"

  run run_plan_review_loop "$TMPDIR_TEST" "$TMPDIR_TEST" "run-1" "repo-1" "main" "60" "5"
  [[ $status -ne 0 ]]
}

@test "run_plan_review_loop: converges after fixer resolves P1" {
  _iter=0
  run_adversarial_reviewer() {
    _iter=$((_iter + 1))
    if [[ $_iter -eq 1 ]]; then
      echo "### P1: Bad state transition" > "${WORKTREE_DIR}/plan-review-findings.md"
    else
      echo "## Review Result: PASS" > "${WORKTREE_DIR}/plan-review-findings.md"
    fi
    return 0
  }
  run_plan_fixer() { return 0; }
  _iter=0

  run run_plan_review_loop "$TMPDIR_TEST" "$TMPDIR_TEST" "run-1" "repo-1" "main" "60" "5"
  [[ $status -eq 0 ]]
}
