#!/usr/bin/env bash
# poll_compound.sh — helpers for the PR review poll to emit signal-gated
# compound docs. Sourced by ai-pr-review-poll and by bats tests.
#
# Required env from caller:
#   ISSUES_DIR              — per-PR artifact dir
#   PROCESSED_IDS_FILE      — non-empty if any comments reached terminal state
#   TOTAL_POLLS             — int, loop iteration count
#   BLOCKED_EXIT            — true/false
#   DID_PUSH_COMMITS          — int, commits the agent pushed during this run
#   CONTRADICTION_FIRED     — true/false (reserved for future use; set by caller
#                             when the review-fix contradiction reconciliation
#                             path is taken)

should_emit_compound() {
  if [[ "${DID_PUSH_COMMITS:-0}" -gt 0 ]]; then return 0; fi
  if [[ "${BLOCKED_EXIT:-false}" == "true" ]]; then return 0; fi
  if [[ "${CONTRADICTION_FIRED:-false}" == "true" ]]; then return 0; fi
  # Snapshot-based: only signal if NEW comments were processed this run.
  # Prevents false positives on quiet re-runs where PROCESSED_IDS_FILE
  # retains content from a prior poll loop invocation.
  local current_count=0
  if [[ -f "${PROCESSED_IDS_FILE:-}" ]]; then
    current_count=$(wc -l < "$PROCESSED_IDS_FILE" | tr -d ' ')
  fi
  if [[ "${current_count}" -gt "${PROCESSED_IDS_COUNT_START:-0}" ]]; then return 0; fi
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

  local agent_target
  local final_target="${ISSUES_DIR}/compound-${ts}.md"

  # opencode sandboxes agent writes to the worktree directory. Write inside
  # POLL_WORKTREE (where the agent can reach), then promote to ISSUES_DIR.
  if [[ -n "${POLL_WORKTREE:-}" ]]; then
    agent_target="${POLL_WORKTREE}/.review-context/compound-${ts}.md"
  else
    agent_target="$final_target"
  fi

  COMPOUND_OUT="$agent_target"

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
    echo "Loop stats: TOTAL_POLLS=${TOTAL_POLLS:-0}, DID_PUSH_COMMITS=${DID_PUSH_COMMITS:-0}, BLOCKED_EXIT=${BLOCKED_EXIT:-false}, CONTRADICTION_FIRED=${CONTRADICTION_FIRED:-false}, processed=${processed_count}, replied=${replied_count}"
    echo ""
    if [[ -n "${POLL_WORKTREE:-}" ]]; then
      echo "Your working directory: ${POLL_WORKTREE}"
      echo "Write your output relative to the working directory."
      echo ""
    fi
    echo "## TASK"
    echo "Write a markdown document to: ${agent_target}"
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

  log "  Emitting compound doc to ${final_target}"
  run_agent "compound" 300 < "$prompt_file" || warn "  compound agent exited non-zero"
  rm -f "$prompt_file"

  # Promote from sandbox (worktree) to ISSUES_DIR
  if [[ "$agent_target" != "$final_target" ]]; then
    mkdir -p "$(dirname "$final_target")"
    cp "$agent_target" "$final_target" 2>/dev/null || true
  fi

  if [[ -f "$final_target" ]]; then
    log "  Compound doc written: ${final_target}"
    return 0
  else
    warn "  Compound doc not written"
    return 1
  fi
}
