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
    /^_checksum_file\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$SCRIPT_PATH")"

  eval "$(awk '
    /^_check_excluded_file_integrity\(\)/ { found=1 }
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
  _COMMITTED_DIFF_FILES=""
  _LS_FILES=""
  git() {
    case "$*" in
      *"--name-only"*"..HEAD"*) echo "$_COMMITTED_DIFF_FILES";;
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

@test "_check_review_worktree_violations: default allowlist accepts task-manifest.json" {
  _DIFF_FILES="task-manifest.json"
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

@test "_check_review_worktree_violations: fails for committed source changes when pre-SHA provided" {
  _DIFF_FILES=""
  _LS_FILES=""
  _COMMITTED_DIFF_FILES="src/index.ts"
  run _check_review_worktree_violations "$TMPDIR_TEST" "abc123"
  [[ $status -ne 0 ]]
}

@test "_check_review_worktree_violations: passes when only allowed files committed with pre-SHA" {
  _DIFF_FILES=""
  _LS_FILES=""
  _COMMITTED_DIFF_FILES="plan.md"
  run _check_review_worktree_violations "$TMPDIR_TEST" "abc123"
  [[ $status -eq 0 ]]
}

@test "_check_review_worktree_violations: reviewer allowlist rejects plan.md edits" {
  _DIFF_FILES="plan.md"
  _LS_FILES=""
  local reviewer_allowlist='^plan-review-findings\.md$'
  run _check_review_worktree_violations "$TMPDIR_TEST" "" "$reviewer_allowlist"
  [[ $status -ne 0 ]]
}

@test "_check_review_worktree_violations: reviewer allowlist accepts findings file" {
  _DIFF_FILES="plan-review-findings.md"
  _LS_FILES=""
  local reviewer_allowlist='^plan-review-findings\.md$'
  run _check_review_worktree_violations "$TMPDIR_TEST" "" "$reviewer_allowlist"
  [[ $status -eq 0 ]]
}

@test "_check_review_worktree_violations: reviewer allowlist rejects pass marker" {
  _DIFF_FILES="plan-review-passed.marker"
  _LS_FILES=""
  local reviewer_allowlist='^plan-review-findings\.md$'
  run _check_review_worktree_violations "$TMPDIR_TEST" "" "$reviewer_allowlist"
  [[ $status -ne 0 ]]
}

# ── _check_excluded_file_integrity ──────────────────────────────────────────

@test "_check_excluded_file_integrity: passes when file unchanged" {
  echo "content" > "$TMPDIR_TEST/plan.md"
  local checksum
  checksum=$(_checksum_file "$TMPDIR_TEST/plan.md")
  run _check_excluded_file_integrity "$TMPDIR_TEST/plan.md" "$checksum" "plan.md"
  [[ $status -eq 0 ]]
}

@test "_check_excluded_file_integrity: fails when file modified" {
  echo "original" > "$TMPDIR_TEST/plan.md"
  local checksum
  checksum=$(_checksum_file "$TMPDIR_TEST/plan.md")
  echo "modified by reviewer" > "$TMPDIR_TEST/plan.md"
  run _check_excluded_file_integrity "$TMPDIR_TEST/plan.md" "$checksum" "plan.md"
  [[ $status -ne 0 ]]
  [[ "$output" =~ "contract violation" ]]
}

@test "_check_excluded_file_integrity: fails when file created from nothing" {
  local checksum=""
  echo "new content" > "$TMPDIR_TEST/plan.md"
  run _check_excluded_file_integrity "$TMPDIR_TEST/plan.md" "$checksum" "plan.md"
  [[ $status -ne 0 ]]
}

@test "_check_excluded_file_integrity: passes when both missing" {
  run _check_excluded_file_integrity "$TMPDIR_TEST/nonexistent.md" "" "nonexistent.md"
  [[ $status -eq 0 ]]
}

@test "_check_excluded_file_integrity: fails when file deleted" {
  echo "content" > "$TMPDIR_TEST/plan.md"
  local checksum
  checksum=$(_checksum_file "$TMPDIR_TEST/plan.md")
  rm "$TMPDIR_TEST/plan.md"
  run _check_excluded_file_integrity "$TMPDIR_TEST/plan.md" "$checksum" "plan.md"
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
  run_adversarial_reviewer() {
    echo "## Review Result: PASS" > "${WORKTREE_DIR}/plan-review-findings.md"
    return 0;
  }
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

@test "run_plan_review_loop: stale findings file is removed before reviewer" {
  # Pre-create a stale PASS findings file from a "previous" review
  echo "## Review Result: PASS" > "$TMPDIR_TEST/plan-review-findings.md"

  # Reviewer succeeds but writes nothing (simulating a crash/no-output)
  run_adversarial_reviewer() { return 0; }
  run_plan_fixer() { return 0; }

  run run_plan_review_loop "$TMPDIR_TEST" "$TMPDIR_TEST" "run-1" "repo-1" "main" "60" "5"
  # Should fail because stale file was removed and reviewer produced nothing
  [[ $status -ne 0 ]]
}

@test "run_plan_review_loop: final review pass evaluates fixer output on last iteration" {
  # With max_iter=2: iter 1 reviewer finds P1, fixer runs; iter 2 reviewer
  # finds P1 again, fixer runs; final review still finds P1 → escalate.
  run_adversarial_reviewer() {
    echo "### P1: Bad state transition" > "${WORKTREE_DIR}/plan-review-findings.md"
    return 0
  }
  run_plan_fixer() { return 0; }

  run run_plan_review_loop "$TMPDIR_TEST" "$TMPDIR_TEST" "run-1" "repo-1" "main" "60" "2"
  # Final review also found P1 → should escalate (exit 1)
  [[ $status -ne 0 ]]
}

@test "run_plan_review_loop: final review pass succeeds when fix resolves P1 on last iteration" {
  # With max_iter=1: iter 1 reviewer finds P1, fixer runs; final review
  # finds PASS → success.
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

  run run_plan_review_loop "$TMPDIR_TEST" "$TMPDIR_TEST" "run-1" "repo-1" "main" "60" "1"
  [[ $status -eq 0 ]]
}
