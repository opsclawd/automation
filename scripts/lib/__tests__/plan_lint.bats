#!/usr/bin/env bats

setup() {
  SCRIPT_PATH="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/ai-run-issue-v2"

  eval "$(awk '
    /^_lint_plan_verification\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$SCRIPT_PATH")"

  LOG_OUTPUT=""
  log() { LOG_OUTPUT="${LOG_OUTPUT}$*\n"; }
  warn() { log "WARN: $*"; }
  EMIT_EVENT_ARGS=""
  emit_event() { EMIT_EVENT_ARGS="$*"; }

  TMPDIR_TEST="$(mktemp -d)"
  WORKTREE_DIR="$TMPDIR_TEST"
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

@test "lint: whole-file grep without line-range restriction emits warning" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Some task

### Files
- Modify: `scripts/ai-run-issue-v2`

### Validation
Run: `grep -n 'some pattern' scripts/ai-run-issue-v2`
Expected: exit code 0
PLAN

  _lint_plan_verification
  [[ "$EMIT_EVENT_ARGS" == *"plan.lint.warning"* ]]
}

@test "lint: scoped grep does not emit warning" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Some task

### Validation
Run: `grep -n 'some pattern' scripts/ai-run-issue-v2 | awk 'NR>=100 && NR<=200'`
Expected: exit code 0
PLAN

  EMIT_EVENT_ARGS=""
  _lint_plan_verification
  [[ "$EMIT_EVENT_ARGS" != *"plan.lint.warning"* ]]
}

@test "lint: pnpm test commands do not emit warning" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Some task

### Validation
Run: `pnpm test:bash -- scripts/lib/__tests__/foo.bats`
Expected: exit code 0
PLAN

  EMIT_EVENT_ARGS=""
  _lint_plan_verification
  [[ "$EMIT_EVENT_ARGS" != *"plan.lint.warning"* ]]
}

@test "lint: missing plan.md does not fail" {
  _lint_plan_verification
  [[ "$EMIT_EVENT_ARGS" != *"plan.lint.warning"* ]]
}

@test "lint: validation-suite task title emits warning" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 4: Validation Suite

### Validation
Run: pnpm test
PLAN

  EMIT_EVENT_ARGS=""
  _lint_plan_verification
  [[ "$EMIT_EVENT_ARGS" == *"plan.lint.validation_task"* ]]
}

@test "lint: full validation task title emits warning" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 5: Full Validation

### Validation
Run: pnpm test
PLAN

  EMIT_EVENT_ARGS=""
  _lint_plan_verification
  [[ "$EMIT_EVENT_ARGS" == *"plan.lint.validation_task"* ]]
}

@test "lint: run validation task title emits warning" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 6: Run Validation

### Validation
Run: pnpm test
PLAN

  EMIT_EVENT_ARGS=""
  _lint_plan_verification
  [[ "$EMIT_EVENT_ARGS" == *"plan.lint.validation_task"* ]]
}

@test "lint: make green task title emits warning" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 7: Make Tests Green

### Validation
Run: pnpm test
PLAN

  EMIT_EVENT_ARGS=""
  _lint_plan_verification
  [[ "$EMIT_EVENT_ARGS" == *"plan.lint.validation_task"* ]]
}

@test "lint: make pass task title emits warning" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 8: Make All Tests Pass

### Validation
Run: pnpm test
PLAN

  EMIT_EVENT_ARGS=""
  _lint_plan_verification
  [[ "$EMIT_EVENT_ARGS" == *"plan.lint.validation_task"* ]]
}

@test "lint: fix failing test task title emits warning" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 9: Fix Failing Test

### Validation
Run: pnpm test
PLAN

  EMIT_EVENT_ARGS=""
  _lint_plan_verification
  [[ "$EMIT_EVENT_ARGS" == *"plan.lint.validation_task"* ]]
}

@test "lint: normal implementation task with validate keyword does not emit warning" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 3: Implement migration script

### Files
- Modify: scripts/migrate.sh

### Validation
Validate the data migration script works correctly
PLAN

  EMIT_EVENT_ARGS=""
  _lint_plan_verification
  [[ "$EMIT_EVENT_ARGS" != *"plan.lint.validation_task"* ]]
}

@test "lint: case insensitive matching for validation task patterns" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## task 10: VALIDATION SUITE

### Validation
Run: pnpm test
PLAN

  EMIT_EVENT_ARGS=""
  _lint_plan_verification
  [[ "$EMIT_EVENT_ARGS" == *"plan.lint.validation_task"* ]]
}
