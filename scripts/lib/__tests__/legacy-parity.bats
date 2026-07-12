#!/usr/bin/env bats

setup() {
  cd "${BATS_TEST_DIRNAME}/../../.."
}

@test "parity[#250]: tightened error patterns require HTTP/statusCode context" {
  # Extract lines 1-18 of error-patterns.ts
  local patterns
  patterns=$(sed -n '1,18p' packages/infrastructure/src/agent/error-patterns.ts)

  # Verify that any line in the pattern arrays containing 429 or 5\d{2} contains HTTP or status context
  echo "$patterns" | grep "429" | while read -r line; do
    echo "$line" | grep -Ei "status|HTTP" || {
      echo "Failure: 429 pattern lacks context in line: $line"
      return 1
    }
  done

  echo "$patterns" | grep "5\\\\d{2}" | while read -r line; do
    echo "$line" | grep -Ei "status|HTTP" || {
      echo "Failure: 5xx pattern lacks context in line: $line"
      return 1
    }
  done

  # Verify focused vitest suite passes
  run pnpm --filter @ai-sdlc/infrastructure test -- error-patterns.test.ts --run
  [ "$status" -eq 0 ]
}
@test "parity[#250]: opencode-adapter streams child stdout but not stderr to process streams" {
  local spawn_section
  spawn_section=$(sed -n '/const child = execa/,/watchdogInterval = this.startWatchdog/p' packages/infrastructure/src/agent/opencode-adapter.ts)

  echo "$spawn_section" | grep -q "child.stdout.pipe(process.stdout, { end: false })" || {
    echo "Failure: stdout piping missing or incorrect format in opencode-adapter"
    return 1
  }

  echo "$spawn_section" | grep -q "child.stderr.pipe(process.stderr" && {
    echo "Failure: stderr piping should not be present in opencode-adapter"
    return 1
  }
  return 0
}

@test "parity[#250]: external-cli-runner streams both child stdout and stderr to process streams" {
  local spawn_section
  spawn_section=$(sed -n '/const child = execa/,/cancelSignal?.addEventListener/p' packages/infrastructure/src/agent/external-cli-runner.ts)

  echo "$spawn_section" | grep -q "child.stdout.pipe(process.stdout, { end: false })" || {
    echo "Failure: stdout piping missing or incorrect format in external-cli-runner"
    return 1
  }

  echo "$spawn_section" | grep -q "child.stderr.pipe(process.stderr, { end: false })" || {
    echo "Failure: stderr piping missing or incorrect format in external-cli-runner"
    return 1
  }
  return 0
}

