#!/usr/bin/env bash
# review-contract.sh — Off-contract recovery for spec/quality reviewer artifacts (#305).
# Source this file in scripts that need validate_review_verdict / build_corrective_warning
# / recover_off_contract_review_artifacts.
# validate_review_verdict: checks that the .result file exists AND contains
# an allowed value. Returns 0 if valid, 1 if file missing, 2 if value invalid.
# Args: result_file allowed_value1 [allowed_value2 ...]
validate_review_verdict() {
  local result_file="$1"; shift
  local allowed_values=("$@")
  local val
  if [[ ! -f "$result_file" ]]; then
    return 1  # missing
  fi
  val=$(head -1 "$result_file" 2>/dev/null | tr -d '[:space:]' || true)
  if [[ -z "$val" ]]; then
    return 2  # empty / invalid
  fi
  local match=false
  for allowed in "${allowed_values[@]}"; do
    if [[ "$val" == "$allowed" ]]; then
      match=true
      break
    fi
  done
  if $match; then
    return 0  # valid
  fi
  return 2  # invalid value
}
# build_corrective_warning: produce a violation-specific warning message to
# prepend to the retry prompt, replacing the generic RERUN_WARNING.
# Args: reviewer_type task_n violation_type [actual_verdict] [actual_path]
# violation_type: "invalid_verdict"
build_corrective_warning() {
  local reviewer_type="$1"    # "spec" or "quality"
  local task_n="$2"
  local violation_type="$3"   # "invalid_verdict"
  local actual_verdict="$4"   # the invalid verdict value (if known)
  local actual_path="$5"      # unused, kept for caller compatibility
  case "$violation_type" in
    invalid_verdict)
      echo "WARNING: Your previous attempt wrote verdict '${actual_verdict}' which is NOT an allowed value. You MUST choose EXACTLY one of the allowed values listed in the MANDATORY OUTPUT FILES section — no other text, no alternatives."
      ;;
  esac
}
# recover_off_contract_review_artifacts: scan common wrong locations for review
# artifacts and relocate them to the expected paths. Returns 0 if artifacts
# are already at expected paths or were recovered, 1 if nothing found.
# Assumes WORKTREE_DIR is set in caller scope (dynamic bash global).
# Args: reviewer_type task_n
recover_off_contract_review_artifacts() {
  local reviewer_type="$1"  # "spec" or "quality"
  local task_n="$2"
  local expected_result="${WORKTREE_DIR}/${reviewer_type}-review-task-${task_n}.result"
  local expected_md="${WORKTREE_DIR}/${reviewer_type}-review-task-${task_n}.md"
  # Already have valid artifacts at expected paths — nothing to recover
  if [[ -f "$expected_result" && -f "$expected_md" ]]; then
    return 0
  fi
  # Scan common wrong locations within WORKTREE_DIR
  local scan_dirs=(
    "${WORKTREE_DIR}/docs"
    "${WORKTREE_DIR}/docs/spec-vs-implementation-reviews"
    "${WORKTREE_DIR}/docs/reviews"
    "${WORKTREE_DIR}/review"
    "${WORKTREE_DIR}/reviews"
    "${WORKTREE_DIR}/output"
    "${WORKTREE_DIR}/out"
  )
  local found_result="" found_md=""
  for dir in "${scan_dirs[@]}"; do
    [[ ! -d "$dir" ]] && continue
    local candidate
    candidate=$(find "$dir" -maxdepth 1 -type f \
      \( -name "*-task-${task_n}.result" -o -name "*-TASK-${task_n}.result" -o -name "TASK-${task_n}.result" -o -name "task-${task_n}.result" \) \
      2>/dev/null | head -1)
    if [[ -n "$candidate" && -z "$found_result" ]]; then
      found_result="$candidate"
    fi
    candidate=$(find "$dir" -maxdepth 1 -type f \
      \( -name "*-task-${task_n}.md" -o -name "*-TASK-${task_n}.md" -o -name "TASK-${task_n}.md" -o -name "task-${task_n}.md" \) \
      2>/dev/null | head -1)
    if [[ -n "$candidate" && -z "$found_md" ]]; then
      found_md="$candidate"
    fi
  done
  local recovered=false
  if [[ -n "$found_result" && ! -f "$expected_result" ]]; then
    cp "$found_result" "$expected_result"
    log "  Recovered ${reviewer_type}-review-task-${task_n}.result from ${found_result}"
    recovered=true
  fi
  if [[ -n "$found_md" && ! -f "$expected_md" ]]; then
    cp "$found_md" "$expected_md"
    log "  Recovered ${reviewer_type}-review-task-${task_n}.md from ${found_md}"
    recovered=true
  fi
  if $recovered || [[ -f "$expected_result" || -f "$expected_md" ]]; then
    return 0
  fi
  return 1
}