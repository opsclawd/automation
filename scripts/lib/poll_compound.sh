#!/usr/bin/env bash
# poll_compound.sh — helpers for the PR review poll to emit signal-gated
# compound docs. Sourced by ai-pr-review-poll and by bats tests.
#
# Required env from caller:
#   ISSUES_DIR              — per-PR artifact dir
#   PROCESSED_IDS_FILE      — non-empty if any comments reached terminal state
#   TOTAL_POLLS             — int, loop iteration count
#   BLOCKED_EXIT            — true/false
#   COMMITS_PUSHED          — int, commits the agent pushed during this run
#   CONTRADICTION_FIRED     — true/false (reserved for future use; set by caller
#                             when the review-fix contradiction reconciliation
#                             path is taken)

should_emit_compound() {
  if [[ "${COMMITS_PUSHED:-0}" -gt 0 ]]; then return 0; fi
  if [[ "${TOTAL_POLLS:-0}" -gt 1 ]]; then return 0; fi
  if [[ "${BLOCKED_EXIT:-false}" == "true" ]]; then return 0; fi
  if [[ "${CONTRADICTION_FIRED:-false}" == "true" ]]; then return 0; fi
  if [[ -s "${PROCESSED_IDS_FILE:-/dev/null}" ]]; then return 0; fi
  return 1
}
