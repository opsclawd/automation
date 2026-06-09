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
  echo "# Plan" > "${WORKTREE_DIR}/docs/README.md"

  _main_checkout_violations="something.ts "
  _worktree_violations="docs/README.md "
  _all_violations="${_main_checkout_violations}${_worktree_violations}"

  _remediate_plan_write_violations

  [[ -n "$_all_violations" ]]
  [[ ! -f "${WORKTREE_DIR}/plan.md" ]]
}

@test "does not remediate multiple worktree violations" {
  mkdir -p "${WORKTREE_DIR}/docs"
  echo "# A" > "${WORKTREE_DIR}/docs/plan-a.md"
  echo "# B" > "${WORKTREE_DIR}/docs/plan-b.md"

  _main_checkout_violations=""
  _worktree_violations="docs/plan-a.md docs/plan-b.md "
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

@test "does not remediate non-plan .md file (e.g. README.md)" {
  mkdir -p "${WORKTREE_DIR}/docs"
  echo "# Readme" > "${WORKTREE_DIR}/docs/README.md"

  _main_checkout_violations=""
  _worktree_violations="docs/README.md "
  _all_violations="${_worktree_violations}"

  _remediate_plan_write_violations

  [[ -n "$_all_violations" ]]
  [[ ! -f "${WORKTREE_DIR}/plan.md" ]]
  [[ -f "${WORKTREE_DIR}/docs/README.md" ]]
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
  _worktree_violations="plan-draft.md "
  _all_violations="${_worktree_violations}"

  _remediate_plan_write_violations

  [[ -n "$_all_violations" ]]
  [[ ! -f "${WORKTREE_DIR}/plan.md" ]]
}

@test "does not remediate when violation file is tracked in git" {
  git -C "$WORKTREE_DIR" init
  git -C "$WORKTREE_DIR" config user.email "test@test.com"
  git -C "$WORKTREE_DIR" config user.name "Test"
  mkdir -p "${WORKTREE_DIR}/docs"
  echo "# Tracked" > "${WORKTREE_DIR}/docs/plan-notes.md"
  git -C "$WORKTREE_DIR" add docs/plan-notes.md
  git -C "$WORKTREE_DIR" commit -m "init"

  _main_checkout_violations=""
  _worktree_violations="docs/plan-notes.md "
  _all_violations="${_main_checkout_violations}${_worktree_violations}"

  _remediate_plan_write_violations

  [[ -n "$_all_violations" ]]
  [[ ! -f "${WORKTREE_DIR}/plan.md" ]]
  [[ -f "${WORKTREE_DIR}/docs/plan-notes.md" ]]
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

@test "remediates single-level .md at worktree root (e.g. my-plan.md)" {
  echo "# Notes" > "${WORKTREE_DIR}/my-plan.md"

  _main_checkout_violations=""
  _worktree_violations="my-plan.md "
  _all_violations="${_worktree_violations}"

  _remediate_plan_write_violations

  [[ -z "$_all_violations" ]]
  [[ -f "${WORKTREE_DIR}/plan.md" ]]
  [[ ! -f "${WORKTREE_DIR}/my-plan.md" ]]
  run cat "${WORKTREE_DIR}/plan.md"
  [[ "$output" == "# Notes" ]]
}

@test "detects ignored misplaced plan.md when exclude hides it" {
  git -C "$WORKTREE_DIR" init
  git -C "$WORKTREE_DIR" config user.email "test@test.com"
  git -C "$WORKTREE_DIR" config user.name "Test"
  mkdir -p "${WORKTREE_DIR}/.git/info"
  echo 'plan.md' >> "${WORKTREE_DIR}/.git/info/exclude"
  mkdir -p "${WORKTREE_DIR}/docs"
  echo "# Misplaced" > "${WORKTREE_DIR}/docs/plan.md"

  run _detect_ignored_misplaced_plan
  [[ "$status" -eq 0 ]]
  [[ -f "${WORKTREE_DIR}/plan.md" ]]
  [[ ! -f "${WORKTREE_DIR}/docs/plan.md" ]]
  run cat "${WORKTREE_DIR}/plan.md"
  [[ "$output" == "# Misplaced" ]]
}

@test "detect_ignored_misplaced_plan no-ops when plan.md already exists" {
  git -C "$WORKTREE_DIR" init
  git -C "$WORKTREE_DIR" config user.email "test@test.com"
  git -C "$WORKTREE_DIR" config user.name "Test"
  mkdir -p "${WORKTREE_DIR}/.git/info"
  echo 'plan.md' >> "${WORKTREE_DIR}/.git/info/exclude"
  mkdir -p "${WORKTREE_DIR}/docs"
  echo "# Existing" > "${WORKTREE_DIR}/plan.md"
  echo "# Misplaced" > "${WORKTREE_DIR}/docs/plan.md"

  run _detect_ignored_misplaced_plan
  [[ "$status" -eq 1 ]]
  run cat "${WORKTREE_DIR}/plan.md"
  [[ "$output" == "# Existing" ]]
}

@test "detect_ignored_misplaced_plan no-ops when no misplaced plan exists" {
  git -C "$WORKTREE_DIR" init
  git -C "$WORKTREE_DIR" config user.email "test@test.com"
  git -C "$WORKTREE_DIR" config user.name "Test"
  mkdir -p "${WORKTREE_DIR}/.git/info"
  echo 'plan.md' >> "${WORKTREE_DIR}/.git/info/exclude"

  run _detect_ignored_misplaced_plan
  [[ "$status" -eq 1 ]]
  [[ ! -f "${WORKTREE_DIR}/plan.md" ]]
}

@test "detect_ignored_misplaced_plan emits telemetry on remediation" {
  git -C "$WORKTREE_DIR" init
  git -C "$WORKTREE_DIR" config user.email "test@test.com"
  git -C "$WORKTREE_DIR" config user.name "Test"
  mkdir -p "${WORKTREE_DIR}/.git/info"
  echo 'plan.md' >> "${WORKTREE_DIR}/.git/info/exclude"
  mkdir -p "${WORKTREE_DIR}/docs"
  echo "# Plan" > "${WORKTREE_DIR}/docs/plan.md"

  _detect_ignored_misplaced_plan

  run jq -e '.type == "plan_written.removed_mispath" and .level == "warn" and .metadata.src == "docs/plan.md"' "$AI_RUN_EVENTS_FILE"
  [[ "$status" -eq 0 ]]
}

@test "detect_ignored_misplaced_plan cleans up empty parent dirs" {
  git -C "$WORKTREE_DIR" init
  git -C "$WORKTREE_DIR" config user.email "test@test.com"
  git -C "$WORKTREE_DIR" config user.name "Test"
  mkdir -p "${WORKTREE_DIR}/.git/info"
  echo 'plan.md' >> "${WORKTREE_DIR}/.git/info/exclude"
  mkdir -p "${WORKTREE_DIR}/docs/superpowers/plans"
  echo "# Plan" > "${WORKTREE_DIR}/docs/superpowers/plans/plan.md"

  _detect_ignored_misplaced_plan

  [[ -f "${WORKTREE_DIR}/plan.md" ]]
  [[ ! -d "${WORKTREE_DIR}/docs/superpowers/plans" ]]
  [[ ! -d "${WORKTREE_DIR}/docs/superpowers" ]]
  [[ ! -d "${WORKTREE_DIR}/docs" ]]
}

@test "detect_ignored_misplaced_plan does not remove non-empty parent dirs" {
  git -C "$WORKTREE_DIR" init
  git -C "$WORKTREE_DIR" config user.email "test@test.com"
  git -C "$WORKTREE_DIR" config user.name "Test"
  mkdir -p "${WORKTREE_DIR}/.git/info"
  echo 'plan.md' >> "${WORKTREE_DIR}/.git/info/exclude"
  mkdir -p "${WORKTREE_DIR}/docs"
  echo "# Plan" > "${WORKTREE_DIR}/docs/plan.md"
  echo "keep" > "${WORKTREE_DIR}/docs/README.md"

  _detect_ignored_misplaced_plan

  [[ -f "${WORKTREE_DIR}/plan.md" ]]
  [[ -f "${WORKTREE_DIR}/docs/README.md" ]]
  [[ -d "${WORKTREE_DIR}/docs" ]]
}

@test "ai-run-issue-v2 sources plan-write-remediation.sh" {
  run grep -q 'source.*plan-write-remediation.sh' "${REAL_REPO_ROOT}/scripts/ai-run-issue-v2"
  [[ "$status" -eq 0 ]]
}

@test "ai-run-issue-v2 calls _remediate_plan_write_violations" {
  run grep -cE '^[[:space:]]+_remediate_plan_write_violations$' "${REAL_REPO_ROOT}/scripts/ai-run-issue-v2"
  [[ "$output" -eq 1 ]]
}

@test "_detect_ignored_misplaced_artifact moves design.md from subdir" {
  git -C "$WORKTREE_DIR" init
  git -C "$WORKTREE_DIR" config user.email "test@test.com"
  git -C "$WORKTREE_DIR" config user.name "Test"
  mkdir -p "${WORKTREE_DIR}/.git/info"
  echo 'design.md' >> "${WORKTREE_DIR}/.git/info/exclude"
  mkdir -p "${WORKTREE_DIR}/docs"
  echo "# Misplaced Design" > "${WORKTREE_DIR}/docs/design.md"
  run _detect_ignored_misplaced_artifact "design.md" "plan-design"
  [[ "$status" -eq 0 ]]
  [[ -f "${WORKTREE_DIR}/design.md" ]]
  [[ ! -f "${WORKTREE_DIR}/docs/design.md" ]]
  run cat "${WORKTREE_DIR}/design.md"
  [[ "$output" == "# Misplaced Design" ]]
}

@test "_detect_ignored_misplaced_artifact no-ops when artifact already exists" {
  git -C "$WORKTREE_DIR" init
  git -C "$WORKTREE_DIR" config user.email "test@test.com"
  git -C "$WORKTREE_DIR" config user.name "Test"
  mkdir -p "${WORKTREE_DIR}/.git/info"
  echo 'design.md' >> "${WORKTREE_DIR}/.git/info/exclude"
  mkdir -p "${WORKTREE_DIR}/docs"
  echo "# Existing" > "${WORKTREE_DIR}/design.md"
  echo "# Misplaced" > "${WORKTREE_DIR}/docs/design.md"
  run _detect_ignored_misplaced_artifact "design.md" "plan-design"
  [[ "$status" -eq 1 ]]
  run cat "${WORKTREE_DIR}/design.md"
  [[ "$output" == "# Existing" ]]
}

@test "_remediate_misplaced_artifact moves design.md from worktree violation" {
  mkdir -p "${WORKTREE_DIR}/docs"
  echo "# Design content" > "${WORKTREE_DIR}/docs/design-draft.md"
  _main_checkout_violations=""
  _worktree_violations="docs/design-draft.md "
  _all_violations="${_main_checkout_violations}${_worktree_violations}"
  _remediate_misplaced_artifact "design.md" "design" "plan-design"
  [[ -z "$_all_violations" ]]
  [[ -f "${WORKTREE_DIR}/design.md" ]]
  [[ ! -f "${WORKTREE_DIR}/docs/design-draft.md" ]]
}

@test "_remediate_misplaced_artifact does not remediate when main checkout has violations" {
  mkdir -p "${WORKTREE_DIR}/docs"
  echo "# Design" > "${WORKTREE_DIR}/docs/design.md"
  _main_checkout_violations="something.ts "
  _worktree_violations="docs/design.md "
  _all_violations="${_main_checkout_violations}${_worktree_violations}"
  _remediate_misplaced_artifact "design.md" "design" "plan-design"
  [[ -n "$_all_violations" ]]
  [[ ! -f "${WORKTREE_DIR}/design.md" ]]
}

@test "_remediate_misplaced_artifact does not remediate multiple violations" {
  mkdir -p "${WORKTREE_DIR}/docs"
  echo "# A" > "${WORKTREE_DIR}/docs/design-a.md"
  echo "# B" > "${WORKTREE_DIR}/docs/design-b.md"
  _main_checkout_violations=""
  _worktree_violations="docs/design-a.md docs/design-b.md "
  _all_violations="${_worktree_violations}"
  _remediate_misplaced_artifact "design.md" "design" "plan-design"
  [[ -n "$_all_violations" ]]
  [[ ! -f "${WORKTREE_DIR}/design.md" ]]
}

@test "_remediate_misplaced_artifact does not remediate when design.md already exists" {
  mkdir -p "${WORKTREE_DIR}/docs"
  echo "# Existing" > "${WORKTREE_DIR}/design.md"
  echo "# Stray" > "${WORKTREE_DIR}/docs/stray-design.md"
  _main_checkout_violations=""
  _worktree_violations="docs/stray-design.md "
  _all_violations="${_main_checkout_violations}${_worktree_violations}"
  _remediate_misplaced_artifact "design.md" "design" "plan-design"
  [[ -n "$_all_violations" ]]
  run cat "${WORKTREE_DIR}/design.md"
  [[ "$output" == "# Existing" ]]
}
