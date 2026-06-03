#!/usr/bin/env bats

# Tests for resolve_result's --agent-ec flag in scripts/ai-pr-review-poll.
# When the agent exits non-zero, the extractor should be skipped and the
# hard-coded fallback used instead. When exit code is 0 (or --agent-ec is
# absent), the extractor should still run.
# See: scripts/ai-pr-review-poll — resolve_result()

setup() {
  SCRIPT_PATH="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/ai-pr-review-poll"
  SHARED_LIB="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/lib/result-resolver.sh"
  # Source shared helpers, then extract resolve_result (which references them).
  source "$SHARED_LIB"
  eval "$(awk '
    /^(resolve_result)\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$SCRIPT_PATH")"

  log() { :; }
  extract_result() {
    echo "EXTRACTOR_RAN" > "$TMPDIR_TEST/extractor_called"
    echo "BLOCKED" > "$2"
    return 0
  }

  TMPDIR_TEST="$(mktemp -d)"
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

@test "agent ec=0, no result file: extractor runs normally" {
  touch "$TMPDIR_TEST/test.log"
  run resolve_result \
    "$TMPDIR_TEST/test.result" \
    "$TMPDIR_TEST/test.log" \
    --agent-ec 0 \
    ALL_DONE NO_FIXES_NEEDED PARTIAL BLOCKED \
    PARTIAL
  [ "$status" -eq 0 ]
  [ "$output" = "BLOCKED" ]
  [ -f "$TMPDIR_TEST/extractor_called" ]
}

@test "agent ec non-zero, no result file: extractor skipped, fallback used" {
  touch "$TMPDIR_TEST/test.log"
  run resolve_result \
    "$TMPDIR_TEST/test.result" \
    "$TMPDIR_TEST/test.log" \
    --agent-ec 1 \
    ALL_DONE NO_FIXES_NEEDED PARTIAL BLOCKED \
    PARTIAL
  [ "$status" -eq 0 ]
  [ "$output" = "PARTIAL" ]
  [ ! -f "$TMPDIR_TEST/extractor_called" ]
}

@test "agent ec non-zero, result file exists: result file honored regardless" {
  echo "BLOCKED" > "$TMPDIR_TEST/test.result"
  touch "$TMPDIR_TEST/test.log"
  run resolve_result \
    "$TMPDIR_TEST/test.result" \
    "$TMPDIR_TEST/test.log" \
    --agent-ec 1 \
    ALL_DONE NO_FIXES_NEEDED PARTIAL BLOCKED \
    PARTIAL
  [ "$status" -eq 0 ]
  [ "$output" = "BLOCKED" ]
  [ ! -f "$TMPDIR_TEST/extractor_called" ]
}

@test "agent ec non-zero, result file has valid value: returns file value" {
  echo "ALL_DONE" > "$TMPDIR_TEST/test.result"
  touch "$TMPDIR_TEST/test.log"
  run resolve_result \
    "$TMPDIR_TEST/test.result" \
    "$TMPDIR_TEST/test.log" \
    --agent-ec 2 \
    ALL_DONE NO_FIXES_NEEDED PARTIAL BLOCKED \
    PARTIAL
  [ "$status" -eq 0 ]
  [ "$output" = "ALL_DONE" ]
}

@test "no --agent-ec, no result file: extractor runs (backward compat)" {
  touch "$TMPDIR_TEST/test.log"
  run resolve_result \
    "$TMPDIR_TEST/test.result" \
    "$TMPDIR_TEST/test.log" \
    ALL_DONE NO_FIXES_NEEDED PARTIAL BLOCKED \
    PARTIAL
  [ "$status" -eq 0 ]
  [ "$output" = "BLOCKED" ]
  [ -f "$TMPDIR_TEST/extractor_called" ]
}

@test "no --agent-ec, no result file, no source file: fallback used" {
  run resolve_result \
    "$TMPDIR_TEST/test.result" \
    "$TMPDIR_TEST/test.log" \
    ALL_DONE NO_FIXES_NEEDED PARTIAL BLOCKED \
    PARTIAL
  [ "$status" -eq 0 ]
  [ "$output" = "PARTIAL" ]
}
