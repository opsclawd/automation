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

# emit_compound_doc — writes a per-run compound markdown doc to
# ${ISSUES_DIR}/compound-<ISO-timestamp>.md. Timestamp suffix lets the poll
# loop be rerun against the same PR without clobbering prior docs.
#
# Required env (in addition to should_emit_compound's):
#   PR_NUMBER, PR_BRANCH, OWNER_REPO  — PR identity, included in prompt
#   ISSUE_NUM (optional)              — paired issue if known
#
# Calls run_agent (defined in ai-pr-review-poll). For testing, stub run_agent
# in the test setup before calling this function.
emit_compound_doc() {
  local ts
  ts=$(date -u +'%Y-%m-%dT%H-%M-%SZ')
  COMPOUND_OUT="${ISSUES_DIR}/compound-${ts}.md"

  local processed_count=0 replied_count=0
  if [[ -f "${PROCESSED_IDS_FILE:-}" ]]; then
    processed_count=$(wc -l < "$PROCESSED_IDS_FILE" | tr -d ' ')
  fi
  if [[ -f "${REPLIED_IDS_FILE:-}" ]]; then
    replied_count=$(wc -l < "$REPLIED_IDS_FILE" | tr -d ' ')
  fi

  local prompt_file
  prompt_file=$(mktemp)
  {
    echo "You are writing a compound-engineering raw artifact for a PR review loop."
    echo ""
    echo "## CONTEXT"
    echo "PR: #${PR_NUMBER} on ${OWNER_REPO} (branch ${PR_BRANCH})"
    echo "Paired issue: ${ISSUE_NUM:-unknown}"
    echo "Loop stats: TOTAL_POLLS=${TOTAL_POLLS:-0}, COMMITS_PUSHED=${COMMITS_PUSHED:-0}, BLOCKED_EXIT=${BLOCKED_EXIT:-false}, CONTRADICTION_FIRED=${CONTRADICTION_FIRED:-false}, processed=${processed_count}, replied-pending=${replied_count}"
    echo ""
    echo "Artifact dir: ${ISSUES_DIR}"
    echo "Logs available: poll.log, process-review-p*.log, build-verify-p*.log"
    echo ""
    echo "## TASK"
    echo "Write a markdown document to: ${COMPOUND_OUT}"
    echo ""
    echo "This is RAW MATERIAL, not a curated doc. A later consolidation pass will"
    echo "decide what (if anything) makes it into docs/solutions/."
    echo ""
    echo "Capture only what is genuinely non-obvious:"
    echo "- Contested decisions and how they were resolved"
    echo "- Reviewer pushback that revealed a hidden constraint"
    echo "- Mistakes the agent made and corrected mid-loop"
    echo "- Agent-loop failure modes (contradictions, build flapping, repeated reviewer rounds)"
    echo ""
    echo "Drop anything that just restates the diff or the PR description."
    echo "If genuinely nothing is worth writing, write a one-paragraph file saying so."
    echo ""
    echo "## RULES"
    echo "- Do not commit anything."
    echo "- Do not push."
    echo "- Do not create a PR."
    echo "- Write only the file at the path above."
  } > "$prompt_file"

  log "  Emitting compound doc to ${COMPOUND_OUT}"
  run_agent "compound" 300 < "$prompt_file" || warn "  compound agent exited non-zero"
  rm -f "$prompt_file"

  if [[ -f "$COMPOUND_OUT" ]]; then
    log "  Compound doc written: ${COMPOUND_OUT}"
    return 0
  else
    warn "  Compound doc not written"
    return 1
  fi
}
