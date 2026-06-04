#!/usr/bin/env bash
# Maps a validation CLI exit code to the legacy validation.result token.
# 0 => "passed"; any non-zero (failure, config error, unexpected) => "failed".
# A missing/empty argument defaults to "failed" (fail-safe).

validation_result_from_exit() {
  if [[ "${1:-1}" -eq 0 ]]; then
    echo "passed"
  else
    echo "failed"
  fi
}
