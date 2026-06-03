#!/usr/bin/env bash
# Shared result-resolver helpers used by ai-pr-review-poll and ai-run-issue-v2.
# Source this file in scripts that need read_result_value / validate_result_file.

# Read first non-whitespace token from a result file. Uses `head -1 file`
# (not `cat | head`) so head reads the file directly — no upstream
# producer that could be SIGPIPE'd when head closes after one line.
read_result_value() {
  head -1 "$1" 2>/dev/null | tr -d '[:space:]' || true
}

# validate_result_file: returns 0 if file exists and contains an allowed value
validate_result_file() {
  local result_file="$1"; shift
  local allowed_values=("$@")
  local val

  if [[ ! -f "$result_file" ]]; then
    return 1
  fi

  val=$(read_result_value "$result_file")
  if [[ -z "$val" ]]; then
    return 1
  fi

  local match=false
  for allowed in "${allowed_values[@]}"; do
    if [[ "$val" == "$allowed" ]]; then
      match=true
      break
    fi
  done

  if $match; then
    return 0
  else
    return 1
  fi
}