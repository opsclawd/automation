#!/usr/bin/env bash
# detect_phase: determine which orchestrator phase to resume from based on
# sentinel files in ISSUES_DIR.  Sourced by ai-run-issue-v2 and bats tests.
#
# NOTE: Return values are primarily canonical phase names (read_issue,
# plan-design, plan-write, validate, fix-validate, review-fix, review-triage,
# compound, create-pr, done).  However, some branches return internal dispatch
# keys rather than canonical names — specifically "fix-review" (returned when
# review.md and review-task-manifest.json both exist).  This dispatch key is
# consumed by ai-run-issue-v2 for internal sub-phase routing inside the
# review-fix phase.  Callers MUST handle both canonical names and dispatch keys.

detect_phase() {
  if [[ -n "${ORCHESTRATOR_PHASE:-}" ]]; then
    echo "$ORCHESTRATOR_PHASE"
    return
  fi

  if [[ -f "${ISSUES_DIR}/pr-url.txt" ]]; then
    echo "done"
  elif [[ -f "${ISSUES_DIR}/compound.md" ]]; then
    echo "create-pr"
  elif [[ -f "${ISSUES_DIR}/review.md" ]]; then
    if [[ -f "${ISSUES_DIR}/review-task-manifest.json" ]]; then
      # "fix-review" is an internal dispatch-only key for the fix sub-phase of
      # the canonical review-fix phase. Do NOT rename to "review-fix" without
      # coordinated changes to the bash dispatch blocks in ai-run-issue-v2 for
      # the fix-iteration dispatch (PHASE == "fix-review") and the whole-PR
      # review dispatch (PHASE == "review-fix").
      echo "fix-review"
    else
      echo "review-triage"
    fi
  elif [[ -f "${ISSUES_DIR}/validation.result" ]]; then
    _vr=$(cat "${ISSUES_DIR}/validation.result" 2>/dev/null)
    if [[ "$_vr" == "passed" ]] || [[ -f "${ISSUES_DIR}/fix-validate-done.marker" ]]; then
      # SHA guard: re-validate if branch HEAD changed since last successful validate
      _stored_sha=$(cat "${ISSUES_DIR}/validation.headsha" 2>/dev/null || echo "")
      _current_sha=$(git -C "${WORKTREE_DIR:-.}" rev-parse HEAD 2>/dev/null || echo "")
      if [[ -z "$_stored_sha" ]] || [[ "$_stored_sha" != "$_current_sha" ]]; then
        echo "validate"
      else
        echo "review-fix"
      fi
    else
      echo "fix-validate"
    fi
  elif [[ -f "${ISSUES_DIR}/plan.md" ]]; then
    if [[ -f "${ISSUES_DIR}/plan-review-passed.marker" ]]; then
      detect_resume_point
    else
      echo "plan-review"
    fi
  elif [[ -f "${ISSUES_DIR}/design.md" ]]; then
    echo "plan-write"
  elif [[ -f "${ISSUES_DIR}/issue.json" ]]; then
    echo "plan-design"
  else
    echo "read_issue"
  fi
}
