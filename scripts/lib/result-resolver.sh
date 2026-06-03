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

# resolve_result: try .result file → extractor agent → fallback default
# Usage: resolve_result RESULT_FILE SOURCE_FILE [--agent-ec N] ALLOWED_VAL1 ... ALLOWED_VALN FALLBACK
#
# Optional flags:
#   --agent-ec N  Pass the agent exit code. If non-zero, skip the extractor
#                 step and go straight to fallback.
#
# If the result file belongs to a review task (spec-review-task-*.result or
# quality-review-task-*.result), stale .result files whose matching .md is
# missing are discarded before validation. For implement-task-*.result, the
# fallback is upgraded from "DONE" to "BLOCKED" when no source .md exists
# (prevents phantom-success).
resolve_result() {
  local result_file="$1"
  local source_file="$2"; shift 2
  local all_args=("$@")
  local fallback="${all_args[-1]}"
  local allowed_arr=("${all_args[@]:0:$(( ${#all_args[@]} - 1 ))}")
  local _skip_extractor=false

  if [[ "${all_args[0]}" == "--agent-ec" ]]; then
    local _aec="${all_args[1]:-}"
    if [[ "$_aec" != "0" ]]; then
      _skip_extractor=true
    fi
    allowed_arr=("${all_args[@]:2:$(( ${#all_args[@]} - 3 ))}")
  fi

  # Detect stale result files for review tasks: .result present but .md missing.
  local base_name
  base_name=$(basename "$result_file")
  local is_review_task=false
  if [[ "$base_name" == spec-review-task-*.result || "$base_name" == quality-review-task-*.result ]]; then
    is_review_task=true
  fi

  if $is_review_task && [[ -f "$result_file" && ! -f "$source_file" ]]; then
    log "  Result file present but source .md missing — invalid agent contract, ignoring stale .result"
  else
    if validate_result_file "$result_file" "${allowed_arr[@]}"; then
      local val
      val=$(read_result_value "$result_file")
      log "  Result (file): ${val}"
      echo "$val"
      return 0
    fi
  fi

  if $_skip_extractor; then
    log "  Agent exited non-zero; skipping extractor, using fallback"
  else
    log "  Result file missing or invalid, trying extractor..."
    if [[ -f "$source_file" ]]; then
      if extract_result "$(basename "$result_file" .result)" "$result_file" "$source_file" "${allowed_arr[@]}"; then
        local val
        val=$(read_result_value "$result_file")
        log "  Result (extractor): ${val}"
        echo "$val"
        return 0
      fi
    fi
  fi

  # Conservative fallback: for implement-task results, default DONE → BLOCKED
  # when no source exists (prevents phantom success).
  local effective_fallback="$fallback"
  if [[ "$base_name" == implement-task-*.result && "$fallback" == "DONE" ]]; then
    effective_fallback="BLOCKED"
  fi
  log "  Result (fallback): ${effective_fallback}"
  echo "$effective_fallback" > "$result_file" 2>/dev/null || true
  echo "$effective_fallback"
  return 0
}