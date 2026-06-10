#!/usr/bin/env bash
# scripts/lib/fix-review-stash.sh
# Preserve uncommitted agent work after revalidation.
#
# Dependencies (must be defined by caller before sourcing):
#   warn()        — log a warning to stderr
#   emit_event()  — emit a structured telemetry event
#
# The function checks whether _revalidate_is_green() is available; if not,
# it falls back to checking the log file directly for "[* failed]" markers.

# _stash_and_conditionally_commit WORKTREE_DIR TASK_ID COMMIT_MSG REVALIDATE_LOG
#
# Stash uncommitted changes after revalidation. If revalidation passed,
# pop the stash and commit on behalf of the agent. If revalidation failed,
# keep the stash for debugging.
#
# Returns 0 always (never fails the caller).
_stash_and_conditionally_commit() {
  local worktree_dir=$1
  local task_id=$2
  local commit_msg=$3
  local revalidate_log=$4

  if git -C "$worktree_dir" diff --exit-code HEAD 2>/dev/null; then
    return 0  # Tree is clean, nothing to do
  fi

  # Stash uncommitted changes (tracked + untracked)
  git -C "$worktree_dir" stash push -u -m "fix-review-task-${task_id}-revalidate-artifacts" 2>/dev/null || true

  # Determine if revalidation passed
  local _green=0
  if declare -F _revalidate_is_green >/dev/null 2>&1; then
    if _revalidate_is_green "$revalidate_log"; then
      _green=1
    fi
  else
    # Fallback: check the log file directly
    if [[ -f "$revalidate_log" ]] && ! grep -qE '\[(build|lint|typecheck|test|test:bash) failed\]' "$revalidate_log"; then
      _green=1
    fi
  fi

  if [[ $_green -eq 1 ]]; then
    # Revalidation passed — the stash likely contains the agent's fix.
    # Pop and commit on behalf of the agent.
    if git -C "$worktree_dir" stash pop 2>/dev/null; then
      git -C "$worktree_dir" add -A 2>/dev/null
      git -C "$worktree_dir" commit -m "$commit_msg" 2>/dev/null || true
      if declare -F emit_event >/dev/null 2>&1; then
        emit_event "fix-review" "info" "task.work_committed" \
          "fix-review task ${task_id}: uncommitted work committed after green revalidate" \
          task_id="$task_id"
      fi
    else
      if declare -F warn >/dev/null 2>&1; then
        warn "Task ${task_id}: stash pop failed — stash may conflict. Keeping stash for debugging."
      fi
      if declare -F emit_event >/dev/null 2>&1; then
        emit_event "fix-review" "warn" "task.stash_pop_failed" \
          "fix-review task ${task_id}: stash pop failed" \
          task_id="$task_id"
      fi
    fi
  else
    # Revalidation failed — stash contains build artifacts (and possibly partial work).
    # Keep stash for debugging, tree is now clean for next retry.
    if declare -F warn >/dev/null 2>&1; then
      warn "Task ${task_id}: revalidation red — stashed artifacts retained for debugging"
    fi
    if declare -F emit_event >/dev/null 2>&1; then
      emit_event "fix-review" "info" "task.stash_retained" \
        "fix-review task ${task_id}: stash retained (revalidation red)" \
        task_id="$task_id"
    fi
  fi
}
