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

  LOG_OUTPUT=""
  log() { LOG_OUTPUT="${LOG_OUTPUT}$*\n"; }
  warn() { log "WARN: $*"; }

  TMPDIR_TEST="$(mktemp -d)"
  WORKTREE_DIR="$TMPDIR_TEST"
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
