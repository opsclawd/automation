#!/usr/bin/env bash
# scripts/lib/fix-review-revert.sh
# Revert fix-review task commits when revalidate is red.
#
# Dependencies (must be defined by caller before sourcing):
#   _revalidate_is_green() — true if revalidate log has no failures
#   warn()                  — log a warning to stderr
#   emit_event()            — emit a structured telemetry event

# _revert_task_commits WORKTREE_DIR TASK_ID PRE_TASK_HEAD REVALIDATE_LOG
#
# Revert commits made since PRE_TASK_HEAD if revalidate is red.
# If revalidate is green or no new commits exist, does nothing.
#
# Uses `git revert --no-commit <pre>..HEAD` followed by a single commit
# to produce a clean revert with an audit trail showing what was reverted
# and why.
#
# Returns 0 always (never fails the caller).
_revert_task_commits() {
  local worktree_dir=$1
  local task_id=$2
  local pre_task_head=$3
  local revalidate_log=$4

  if ! declare -F _revalidate_is_green >/dev/null 2>&1; then
    return 0
  fi
  if _revalidate_is_green "$revalidate_log"; then
    return 0
  fi

  local current_head
  current_head=$(git -C "$worktree_dir" rev-parse HEAD 2>/dev/null || echo "")
  if [[ -z "$current_head" || "$current_head" == "$pre_task_head" ]]; then
    return 0
  fi

  if git -C "$worktree_dir" revert --no-commit "${pre_task_head}..HEAD" 2>/dev/null; then
    git -C "$worktree_dir" commit -m "Revert: task ${task_id} — reverted commits after red revalidate" 2>/dev/null || true
    if declare -F emit_event >/dev/null 2>&1; then
      emit_event "review-fix" "warn" "task.commits_reverted" \
        "fix-review task ${task_id}: commits reverted after red revalidate" \
        task_id="$task_id" reverted_from="$pre_task_head"
    fi
  else
    if declare -F warn >/dev/null 2>&1; then
      warn "Task ${task_id}: git revert failed — possibly due to conflicts or dirty tree"
    fi
    if declare -F emit_event >/dev/null 2>&1; then
      emit_event "review-fix" "error" "task.revert_failed" \
        "fix-review task ${task_id}: git revert failed after red revalidate" \
        task_id="$task_id" reverted_from="$pre_task_head"
    fi
  fi
}