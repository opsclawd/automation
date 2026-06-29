#!/usr/bin/env bats

# Tests for resolve_result's stale-result detection in scripts/legacy/ai-run-issue-v2.
# The stale guard only applies to spec-review-task-*/quality-review-task-*
# filenames; implementer and fix-review tasks legitimately write .result
# without .md, and their values must pass through.
# See: scripts/legacy/ai-run-issue-v2 — resolve_result()

setup() {
  SCRIPT_PATH="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/legacy/ai-run-issue-v2"
  SHARED_LIB="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/lib/result-resolver.sh"
  # Source shared helpers, then extract resolve_result (which references them).
  source "$SHARED_LIB"
  # Pull in resolve_result via awk brace-counting.
  eval "$(awk '
    /^(resolve_result)\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$SCRIPT_PATH")"

  # Stubs for dependencies the unit-under-test references.
  log() { :; }
  orchestrator_fail() { echo "BLOCKED: $*"; return 1; }
  extract_result() { return 1; }

  TMPDIR_TEST="$(mktemp -d)"
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

@test "valid pair returns the result value" {
  echo "SPEC_PASS" > "$TMPDIR_TEST/test.result"
  touch "$TMPDIR_TEST/test.md"
  run resolve_result "$TMPDIR_TEST/test.result" "$TMPDIR_TEST/test.md" SPEC_PASS SPEC_FAIL "SPEC_FAIL"
  [ "$status" -eq 0 ]
  [ "$output" = "SPEC_PASS" ]
}

@test "stale spec-review .result without .md falls through to fallback" {
  echo "SPEC_PASS" > "$TMPDIR_TEST/spec-review-task-1.result"
  run resolve_result "$TMPDIR_TEST/spec-review-task-1.result" "$TMPDIR_TEST/spec-review-task-1.md" SPEC_PASS SPEC_FAIL "SPEC_FAIL"
  [ "$status" -eq 0 ]
  [ "$output" = "SPEC_FAIL" ]
}

@test "no files returns fallback" {
  run resolve_result "$TMPDIR_TEST/missing.result" "$TMPDIR_TEST/missing.md" DONE BLOCKED "DONE"
  [ "$status" -eq 0 ]
  [ "$output" = "DONE" ]
}

@test "stale quality-review FAIL without .md falls through to fallback" {
  echo "QUALITY_FAIL" > "$TMPDIR_TEST/quality-review-task-1.result"
  run resolve_result "$TMPDIR_TEST/quality-review-task-1.result" "$TMPDIR_TEST/quality-review-task-1.md" QUALITY_PASS QUALITY_FAIL "QUALITY_FAIL"
  [ "$status" -eq 0 ]
  [ "$output" = "QUALITY_FAIL" ]
}

@test "implementer .result without .md returns the result value (guard does not apply)" {
  echo "BLOCKED" > "$TMPDIR_TEST/implement-task-1.result"
  run resolve_result "$TMPDIR_TEST/implement-task-1.result" "$TMPDIR_TEST/implement-task-1.md" DONE DONE_WITH_CONCERNS BLOCKED NEEDS_CONTEXT "DONE"
  [ "$status" -eq 0 ]
  [ "$output" = "BLOCKED" ]
}

@test "fix-review .result without .md returns the result value (guard does not apply)" {
  echo "DONE_NO_FIXES_NEEDED" > "$TMPDIR_TEST/fix-review-task-1.result"
  run resolve_result "$TMPDIR_TEST/fix-review-task-1.result" "$TMPDIR_TEST/fix-review-task-1.md" DONE DONE_NO_FIXES_NEEDED BLOCKED "DONE"
  [ "$status" -eq 0 ]
  [ "$output" = "DONE_NO_FIXES_NEEDED" ]
}

@test "implement-task with no result file and no .md uses BLOCKED instead of DONE fallback" {
  run resolve_result "$TMPDIR_TEST/implement-task-1.result" "$TMPDIR_TEST/implement-task-1.md" DONE DONE_WITH_CONCERNS BLOCKED NEEDS_CONTEXT "DONE"
  [ "$status" -eq 0 ]
  [ "$output" = "BLOCKED" ]
}

@test "implement-task with no result file and non-DONE fallback keeps caller fallback" {
  run resolve_result "$TMPDIR_TEST/implement-task-2.result" "$TMPDIR_TEST/implement-task-2.md" DONE DONE_WITH_CONCERNS BLOCKED "BLOCKED"
  [ "$status" -eq 0 ]
  [ "$output" = "BLOCKED" ]
}

@test "non-implement-task with no result file still uses caller fallback" {
  run resolve_result "$TMPDIR_TEST/plan-design.result" "$TMPDIR_TEST/plan-design.md" DONE BLOCKED "DONE"
  [ "$status" -eq 0 ]
  [ "$output" = "DONE" ]
}
