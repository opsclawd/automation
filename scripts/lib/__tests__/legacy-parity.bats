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


