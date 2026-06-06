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

  eval "$(awk '
    /^_append_known_limitations\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$SCRIPT_PATH")"

  eval "$(awk '
    /^parse_judgment_decision\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$SCRIPT_PATH")"

  eval "$(awk '
    /^run_plan_review_judge\(\)/ { found=1 }
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

@test "parse_review_findings: returns PROCEED_WITH_CONCERNS when sentinel present" {
  cat > "$TMPDIR_TEST/plan-review-findings.md" << 'FINDINGS'
## Review Result: PROCEED_WITH_CONCERNS
**Reasoning:** P1 depends on future infrastructure.
### P1s carried forward
- Missing retry: requires circuit breaker not in scope
FINDINGS
  run parse_review_findings "$TMPDIR_TEST"
  [[ "$output" == "PROCEED_WITH_CONCERNS" ]]
}

@test "parse_review_findings: PROCEED_WITH_CONCERNS takes precedence over P1_FOUND" {
  cat > "$TMPDIR_TEST/plan-review-findings.md" << 'FINDINGS'
## Review Result: PROCEED_WITH_CONCERNS
### P1: Scoped boundary issue
**Plan text:** > retry logic
**What actually happens:** needs future infra
FINDINGS
  run parse_review_findings "$TMPDIR_TEST"
  [[ "$output" == "PROCEED_WITH_CONCERNS" ]]
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

@test "run_plan_review_loop: orchestrator_fail when findings file missing on final review pass" {
  # max_iter=1: iter 1 reviewer finds P1, fixer runs; final review
  # reviewer exits 0 without writing findings → should fail.
  _iter=0
  run_adversarial_reviewer() {
    _iter=$((_iter + 1))
    if [[ $_iter -eq 1 ]]; then
      echo "### P1: Bad state transition" > "${WORKTREE_DIR}/plan-review-findings.md"
    else
      # Final review: exit 0 but don't write findings file
      rm -f "${WORKTREE_DIR}/plan-review-findings.md"
    fi
    return 0
  }
  run_plan_fixer() { return 0; }
  _iter=0

  run run_plan_review_loop "$TMPDIR_TEST" "$TMPDIR_TEST" "run-1" "repo-1" "main" "60" "1"
  [[ $status -ne 0 ]]
}

@test "run_plan_review_loop: reviewer modifying task-manifest.json triggers contract violation" {
  # Reviewer modifies task-manifest.json (git-excluded, so worktree violations
  # won't catch it) — _check_excluded_file_integrity should catch the checksum
  # mismatch.
  echo '{"tasks":[]}' > "$TMPDIR_TEST/task-manifest.json"

  run_adversarial_reviewer() {
    echo '{"tasks":[{"id":1}]}' > "${WORKTREE_DIR}/task-manifest.json"
    echo "## Review Result: PASS" > "${WORKTREE_DIR}/plan-review-findings.md"
    return 0
  }
  run_plan_fixer() { return 0; }

  run run_plan_review_loop "$TMPDIR_TEST" "$TMPDIR_TEST" "run-1" "repo-1" "main" "60" "5"
  [[ $status -ne 0 ]]
}

@test "run_plan_review_loop: archives findings to plan-review-findings-iter-N.md before deletion" {
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
  [[ -f "$TMPDIR_TEST/plan-review-findings-iter-1.md" ]]
  grep -q "P1: Bad state transition" "$TMPDIR_TEST/plan-review-findings-iter-1.md"
}

@test "run_plan_review_loop: exits 0 on PROCEED_WITH_CONCERNS without invoking fixer" {
  _fixer_called=0
  run_adversarial_reviewer() {
    cat > "${WORKTREE_DIR}/plan-review-findings.md" << 'EOF'
## Review Result: PROCEED_WITH_CONCERNS
**Reasoning:** P1 needs future infra.
### P1s carried forward
- Missing retry: requires circuit breaker not in scope
EOF
    return 0
  }
  run_plan_fixer() { _fixer_called=1; return 0; }
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
# Test Plan
## Task 1: Something
PLAN
  run run_plan_review_loop "$TMPDIR_TEST" "$TMPDIR_TEST" "run-1" "repo-1" "main" "60" "5"
  [[ $status -eq 0 ]]
  [[ $_fixer_called -eq 0 ]]
  grep -q "Known Limitations" "$TMPDIR_TEST/plan.md"
}

@test "_append_known_limitations: appends to existing section" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
# Plan
## Known Limitations
- Existing limitation
PLAN
  _append_known_limitations "$TMPDIR_TEST/plan.md" "- New limitation"
  grep -q "New limitation" "$TMPDIR_TEST/plan.md"
  grep -qc "Known Limitations" "$TMPDIR_TEST/plan.md"
}

@test "_append_known_limitations: creates section when absent" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
# Plan
## Task 1: Something
PLAN
  _append_known_limitations "$TMPDIR_TEST/plan.md" "- First limitation"
  grep -q "## Known Limitations" "$TMPDIR_TEST/plan.md"
  grep -q "First limitation" "$TMPDIR_TEST/plan.md"
}

# ── parse_judgment_decision ──────────────────────────────────────────────────

@test "parse_judgment_decision: returns PROCEED for PROCEED judgment" {
  cat > "$TMPDIR_TEST/plan-review-judgment.md" << 'JUDGMENT'
## Judgment: PROCEED
**Reasoning:** Findings were minor across iterations.
JUDGMENT
  run parse_judgment_decision "$TMPDIR_TEST"
  [[ "$output" == "PROCEED" ]]
}

@test "parse_judgment_decision: returns PROCEED_WITH_CAVEATS" {
  cat > "$TMPDIR_TEST/plan-review-judgment.md" << 'JUDGMENT'
## Judgment: PROCEED_WITH_CAVEATS
**Reasoning:** Scoped P1s remain.

### Unresolved P1s carried forward
- Missing retry: needs circuit breaker
JUDGMENT
  run parse_judgment_decision "$TMPDIR_TEST"
  [[ "$output" == "PROCEED_WITH_CAVEATS" ]]
}

@test "parse_judgment_decision: returns ESCALATE" {
  cat > "$TMPDIR_TEST/plan-review-judgment.md" << 'JUDGMENT'
## Judgment: ESCALATE
**Reasoning:** Fundamental design flaw.
JUDGMENT
  run parse_judgment_decision "$TMPDIR_TEST"
  [[ "$output" == "ESCALATE" ]]
}

@test "parse_judgment_decision: returns ESCALATE when file missing" {
  run parse_judgment_decision "$TMPDIR_TEST"
  [[ "$output" == "ESCALATE" ]]
}

@test "parse_judgment_decision: returns ESCALATE for unrecognized judgment" {
  cat > "$TMPDIR_TEST/plan-review-judgment.md" << 'JUDGMENT'
## Judgment: MAYBE
**Reasoning:** Unclear.
JUDGMENT
  run parse_judgment_decision "$TMPDIR_TEST"
  [[ "$output" == "ESCALATE" ]]
}

# ── run_plan_review_judge ────────────────────────────────────────────────────

@test "run_plan_review_judge: writes judgment file and returns 0" {
  node() {
    cat > "${WORKTREE_DIR}/plan-review-judgment.md" << 'JUDGMENT'
## Judgment: PROCEED
**Reasoning:** Findings were minor.
JUDGMENT
    return 0
  }
  _GIT_SHA="abc123"
  _capture_main_state() { echo "main-state"; }
  _guard_main_checkout() { :; }
  check_branch_after_agent() { :; }

  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
# Plan
PLAN

  run run_plan_review_judge "$TMPDIR_TEST" "$TMPDIR_TEST" "run-1" "repo-1" "main" "60"
  [[ $status -eq 0 ]]
  [[ -f "$TMPDIR_TEST/plan-review-judgment.md" ]]
}
