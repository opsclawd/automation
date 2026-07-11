#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "parity[#250]: tightened error patterns require HTTP/statusCode context" {
  local error_patterns="$REPO_ROOT/packages/infrastructure/src/agent/error-patterns.ts"
  ! grep -qE '/\\b429\\b/' "$error_patterns"
  ! grep -qE '/\\b5\\d\{2\}\\b\.\*error/i' "$error_patterns"
  run npx vitest run "$REPO_ROOT/packages/infrastructure/src/agent/__tests__/error-patterns.test.ts"
  [ "$status" -eq 0 ]
}

@test "parity[#250]: opencode-adapter streams child stdout but not stderr to process streams" {
  local file="$REPO_ROOT/packages/infrastructure/src/agent/opencode-adapter.ts"
  run grep -n "child.stdout.pipe(process.stdout)" "$file"
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -ge 1 ]
  run grep -n "child.stderr.pipe(process.stderr)" "$file"
  [ "$status" -ne 0 ] || [ "${#lines[@]}" -eq 0 ]
}

@test "parity[#250]: external-cli-runner streams both child stdout and stderr to process streams" {
  local file="$REPO_ROOT/packages/infrastructure/src/agent/external-cli-runner.ts"
  run grep -n "child.stdout.pipe(process.stdout)" "$file"
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -ge 1 ]
  run grep -n "child.stderr.pipe(process.stderr)" "$file"
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -ge 1 ]
}
