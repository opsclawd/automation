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
## Task 1: Run full validation suite

### Files
- `scripts/ai-run-issue-v2`

### Validation
Run: `pnpm test`
Expected: exit code 0
PLAN

  EMIT_EVENT_ARGS=""
  _lint_plan_verification
  [[ "$EMIT_EVENT_ARGS" == *"plan.lint.validation_task"* ]]
  [[ "$EMIT_EVENT_ARGS" == *"Validation-suite task detected"* ]]
}

@test "lint: make CI green task emits warning" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 2: Make CI green

### Files
- `src/foo.ts`

### Validation
Run: `pnpm lint && pnpm test`
Expected: exit code 0
PLAN

  EMIT_EVENT_ARGS=""
  _lint_plan_verification
  [[ "$EMIT_EVENT_ARGS" == *"plan.lint.validation_task"* ]]
}

@test "lint: fix failing test task emits warning" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 3: Fix failing test in auth module

### Files
- `src/auth.test.ts`

### Validation
Run: `pnpm test -- src/auth.test.ts`
Expected: exit code 0
PLAN

  EMIT_EVENT_ARGS=""
  _lint_plan_verification
  [[ "$EMIT_EVENT_ARGS" == *"plan.lint.validation_task"* ]]
}

@test "lint: implementation task with validate in description does not emit false positive" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Validate the data migration script

### Files
- `scripts/migrate.sh`

### Validation
Run: `bash scripts/migrate.sh --dry-run`
Expected: exit code 0
PLAN

  EMIT_EVENT_ARGS=""
  _lint_plan_verification
  [[ "$EMIT_EVENT_ARGS" != *"plan.lint.validation_task"* ]]
}

@test "lint: run validation in verification section does not emit false positive" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Add new endpoint

### Files
- `src/api.ts`

### Validation
Run: `run validation ./scripts/test.sh`
Expected: exit code 0
PLAN

  EMIT_EVENT_ARGS=""
  _lint_plan_verification
  [[ "$EMIT_EVENT_ARGS" != *"plan.lint.validation_task"* ]]
}
