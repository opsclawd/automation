#!/usr/bin/env bats

# Tests for _remediate_plan_write_violations in lib/plan-write-remediation.sh.

setup() {
  REAL_REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  TMPDIR_TEST="$(mktemp -d)"
  export AI_RUN_EVENTS_FILE="${TMPDIR_TEST}/events.jsonl"
  export AI_RUN_DISPLAY_ID="test-remediation-$(date +%s)"
  export WORKTREE_DIR="${TMPDIR_TEST}/worktree"
  mkdir -p "$WORKTREE_DIR"

  # shellcheck source=../emit_event.sh
  source "${BATS_TEST_DIRNAME}/../emit_event.sh"
  # shellcheck source=../plan-write-remediation.sh
  source "${BATS_TEST_DIRNAME}/../plan-write-remediation.sh"

  log() { :; }
  warn() { log "WARN: $*" >&2; }
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

@test "remediates single .md violation in nested dir, moves to plan.md" {
  mkdir -p "${WORKTREE_DIR}/docs/superpowers/plans"
  echo "# Plan content" > "${WORKTREE_DIR}/docs/superpowers/plans/2026-06-04-test.md"

  _main_checkout_violations=""
  _worktree_violations="docs/superpowers/plans/2026-06-04-test.md "
  _all_violations="${_main_checkout_violations}${_worktree_violations}"

  _remediate_plan_write_violations

  [[ -z "$_all_violations" ]]
  [[ -f "${WORKTREE_DIR}/plan.md" ]]
  [[ ! -f "${WORKTREE_DIR}/docs/superpowers/plans/2026-06-04-test.md" ]]
  [[ ! -d "${WORKTREE_DIR}/docs/superpowers/plans" ]]
  [[ ! -d "${WORKTREE_DIR}/docs/superpowers" ]]
  [[ ! -d "${WORKTREE_DIR}/docs" ]]
  run cat "${WORKTREE_DIR}/plan.md"
  [[ "$output" == "# Plan content" ]]
}

@test "remediates single .md violation with leading and trailing whitespace" {
  mkdir -p "${WORKTREE_DIR}/docs/plans"
  echo "# Plan" > "${WORKTREE_DIR}/docs/plans/test.md"

  _main_checkout_violations=""
  _worktree_violations="  docs/plans/test.md  "
  _all_violations="${_main_checkout_violations}${_worktree_violations}"

  _remediate_plan_write_violations

  [[ -z "$_all_violations" ]]
  [[ -f "${WORKTREE_DIR}/plan.md" ]]
  [[ ! -f "${WORKTREE_DIR}/docs/plans/test.md" ]]
}

@test "does not remediate when main checkout has violations" {
  mkdir -p "${WORKTREE_DIR}/docs"
  echo "# Plan" > "${WORKTREE_DIR}/docs/plan.md"

  _main_checkout_violations="something.ts "
  _worktree_violations="docs/plan.md "
  _all_violations="${_main_checkout_violations}${_worktree_violations}"

  _remediate_plan_write_violations

  [[ -n "$_all_violations" ]]
  [[ ! -f "${WORKTREE_DIR}/plan.md" ]]
}

@test "does not remediate multiple worktree violations" {
  mkdir -p "${WORKTREE_DIR}/docs"
  echo "# A" > "${WORKTREE_DIR}/docs/a.md"
  echo "# B" > "${WORKTREE_DIR}/docs/b.md"

  _main_checkout_violations=""
  _worktree_violations="docs/a.md docs/b.md "
  _all_violations="${_worktree_violations}"

  _remediate_plan_write_violations

  [[ -n "$_all_violations" ]]
  [[ ! -f "${WORKTREE_DIR}/plan.md" ]]
}

@test "does not remediate non-.md violation" {
  echo "code" > "${WORKTREE_DIR}/stray.ts"

  _main_checkout_violations=""
  _worktree_violations="stray.ts "
  _all_violations="${_worktree_violations}"

  _remediate_plan_write_violations

  [[ -n "$_all_violations" ]]
  [[ ! -f "${WORKTREE_DIR}/plan.md" ]]
}

@test "does not remediate when plan.md already exists" {
  mkdir -p "${WORKTREE_DIR}/docs"
  echo "# Existing" > "${WORKTREE_DIR}/plan.md"
  echo "# Stray" > "${WORKTREE_DIR}/docs/stray.md"

  _main_checkout_violations=""
  _worktree_violations="docs/stray.md "
  _all_violations="${_worktree_violations}"

  _remediate_plan_write_violations

  [[ -n "$_all_violations" ]]
  run cat "${WORKTREE_DIR}/plan.md"
  [[ "$output" == "# Existing" ]]
}

@test "does not remediate when violation file does not exist on disk" {
  _main_checkout_violations=""
  _worktree_violations="phantom.md "
  _all_violations="${_worktree_violations}"

  _remediate_plan_write_violations

  [[ -n "$_all_violations" ]]
  [[ ! -f "${WORKTREE_DIR}/plan.md" ]]
}

@test "no-op when no violations" {
  _main_checkout_violations=""
  _worktree_violations=""
  _all_violations=""

  _remediate_plan_write_violations

  [[ -z "$_all_violations" ]]
  [[ ! -f "${WORKTREE_DIR}/plan.md" ]]
}

@test "emits telemetry event on successful remediation" {
  mkdir -p "${WORKTREE_DIR}/docs"
  echo "# Plan" > "${WORKTREE_DIR}/docs/plan.md"

  _main_checkout_violations=""
  _worktree_violations="docs/plan.md "
  _all_violations="${_worktree_violations}"

  _remediate_plan_write_violations

  run jq -e '.type == "plan_written.removed_mispath" and .level == "warn" and .metadata.src == "docs/plan.md"' "$AI_RUN_EVENTS_FILE"
  [[ "$status" -eq 0 ]]
}

@test "does not remove non-empty parent directories" {
  mkdir -p "${WORKTREE_DIR}/docs"
  echo "# Plan" > "${WORKTREE_DIR}/docs/plan.md"
  echo "keep" > "${WORKTREE_DIR}/docs/README.md"

  _main_checkout_violations=""
  _worktree_violations="docs/plan.md "
  _all_violations="${_worktree_violations}"

  _remediate_plan_write_violations

  [[ -z "$_all_violations" ]]
  [[ -f "${WORKTREE_DIR}/plan.md" ]]
  [[ -f "${WORKTREE_DIR}/docs/README.md" ]]
  [[ -d "${WORKTREE_DIR}/docs" ]]
}

@test "remediates single-level .md at worktree root (e.g. notes.md)" {
  echo "# Notes" > "${WORKTREE_DIR}/notes.md"

  _main_checkout_violations=""
  _worktree_violations="notes.md "
  _all_violations="${_worktree_violations}"

  _remediate_plan_write_violations

  [[ -z "$_all_violations" ]]
  [[ -f "${WORKTREE_DIR}/plan.md" ]]
  [[ ! -f "${WORKTREE_DIR}/notes.md" ]]
  run cat "${WORKTREE_DIR}/plan.md"
  [[ "$output" == "# Notes" ]]
}

@test "ai-run-issue-v2 sources plan-write-remediation.sh" {
  run grep -q 'source.*plan-write-remediation.sh' "${REAL_REPO_ROOT}/scripts/ai-run-issue-v2"
  [[ "$status" -eq 0 ]]
}

@test "ai-run-issue-v2 calls _remediate_plan_write_violations" {
  run grep -cE '^[[:space:]]+_remediate_plan_write_violations$' "${REAL_REPO_ROOT}/scripts/ai-run-issue-v2"
  [[ "$output" -eq 1 ]]
}
