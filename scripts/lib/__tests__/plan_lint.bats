#!/usr/bin/env bats

setup() {
  SCRIPT_PATH="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/legacy/ai-run-issue-v2"

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
- Modify: `scripts/legacy/ai-run-issue-v2`

### Validation
Run: `grep -n 'some pattern' scripts/legacy/ai-run-issue-v2`
Expected: exit code 0
PLAN

  _lint_plan_verification
  [[ "$EMIT_EVENT_ARGS" == *"plan.lint.warning"* ]]
}

@test "lint: scoped grep does not emit warning" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Some task

### Validation
Run: `grep -n 'some pattern' scripts/legacy/ai-run-issue-v2 | awk 'NR>=100 && NR<=200'`
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
## Task 1: Some task

### Validation
Run: `pnpm test`
Expected: exit code 0

## Task 2: Run full validation suite

### Files
- Modify: `scripts/legacy/ai-run-issue-v2`

### Validation
Run: `pnpm build && pnpm lint && pnpm test`
PLAN

  EMIT_EVENT_ARGS=""
  _lint_plan_verification
  [[ "$EMIT_EVENT_ARGS" == *"plan.lint.validation_task"* ]]
}

@test "lint: make CI green task emits warning" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 3: Make CI green

### Validation
Run: `pnpm test`
PLAN

  EMIT_EVENT_ARGS=""
  _lint_plan_verification
  [[ "$EMIT_EVENT_ARGS" == *"plan.lint.validation_task"* ]]
}

@test "lint: fix failing tests task emits warning" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 5: Fix failing tests

### Files
- Modify: `packages/domain/src/foo.ts`

### Validation
Run: `pnpm test`
PLAN

  EMIT_EVENT_ARGS=""
  _lint_plan_verification
  [[ "$EMIT_EVENT_ARGS" == *"plan.lint.validation_task"* ]]
}

@test "lint: legitimate validate-in-title task does not emit warning" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Validate the data migration output

### Files
- Modify: `scripts/migrate.sh`

### Validation
Run: `pnpm test:bash -- scripts/lib/__tests__/migrate.bats`
PLAN

  EMIT_EVENT_ARGS=""
  _lint_plan_verification
  [[ "$EMIT_EVENT_ARGS" != *"plan.lint.validation_task"* ]]
}

@test "lint: make tests pass task emits warning" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 2: Make tests pass for arbiter module

### Validation
Run: `pnpm test`
PLAN

  EMIT_EVENT_ARGS=""
  _lint_plan_verification
  [[ "$EMIT_EVENT_ARGS" == *"plan.lint.validation_task"* ]]
}

@test "lint: make build pass task emits warning" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 1: Make build pass

### Validation
Run: `pnpm build`
PLAN

  EMIT_EVENT_ARGS=""
  _lint_plan_verification
  [[ "$EMIT_EVENT_ARGS" == *"plan.lint.validation_task"* ]]
}

@test "lint: make data pass through pipeline does not emit warning" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 3: Make data pass through the pipeline

### Files
- Modify: `packages/domain/src/foo.ts`

### Validation
Run: `pnpm test`
PLAN

  EMIT_EVENT_ARGS=""
  _lint_plan_verification
  [[ "$EMIT_EVENT_ARGS" != *"plan.lint.validation_task"* ]]
}

@test "lint: final verification task emits warning" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 6: Final verification

### Validation
Run: `pnpm test:bash`
PLAN

  EMIT_EVENT_ARGS=""
  _lint_plan_verification
  [[ "$EMIT_EVENT_ARGS" == *"plan.lint.validation_task"* ]]
}

@test "lint: run verification task emits warning" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 5: Run verification

### Validation
Run: `bash -n scripts/legacy/ai-run-issue-v2 && pnpm test:bash`
PLAN

  EMIT_EVENT_ARGS=""
  _lint_plan_verification
  [[ "$EMIT_EVENT_ARGS" == *"plan.lint.validation_task"* ]]
}

@test "lint: full verification task emits warning" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 10: Full verification

### Validation
Run: `pnpm test:bash`
PLAN

  EMIT_EVENT_ARGS=""
  _lint_plan_verification
  [[ "$EMIT_EVENT_ARGS" == *"plan.lint.validation_task"* ]]
}

@test "lint: runtime verification task does not emit warning" {
  cat > "$TMPDIR_TEST/plan.md" << 'PLAN'
## Task 2: Add runtime verification checks

### Files
- Modify: `scripts/legacy/ai-run-issue-v2`

### Validation
Run: `pnpm test:bash -- scripts/lib/__tests__/foo.bats`
PLAN

  EMIT_EVENT_ARGS=""
  _lint_plan_verification
  [[ "$EMIT_EVENT_ARGS" != *"plan.lint.validation_task"* ]]
}
