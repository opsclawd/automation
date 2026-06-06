#!/usr/bin/env bash
# plan-write-remediation.sh — Auto-remediate mispathed plan files
#
# When the plan-write agent writes the plan to a subdirectory instead of
# plan.md at the worktree root, this function moves it to the correct
# location, cleans up empty parent dirs, and emits a telemetry event.
#
# Expected variables in scope:
#   WORKTREE_DIR              — path to the worktree root
#   _main_checkout_violations — violations in the main checkout (space-separated)
#   _worktree_violations      — violations in the worktree (space-separated)
#   _all_violations           — combined violations
#
# Expected functions in scope:
#   warn()       — log a warning
#   emit_event() — telemetry
#   git          — must be on PATH (used to check tracked status)
#
# After calling:
#   _all_violations is cleared on successful remediation (empty string).
_remediate_plan_write_violations() {
  if [[ -n "$_all_violations" ]]; then
    if [[ -z "$_main_checkout_violations" ]]; then
      local _v_count
      _v_count=$(echo "$_worktree_violations" | wc -w)
      if [[ "$_v_count" -eq 1 ]]; then
        local _trimmed_violations
        read -r _trimmed_violations <<< "$_worktree_violations"
        local _v_file="${WORKTREE_DIR}/${_trimmed_violations}"
        if [[ "$_v_file" == *.md && -f "$_v_file" && ! -f "${WORKTREE_DIR}/plan.md" ]] \
            && ! git -C "$WORKTREE_DIR" ls-files --error-unmatch -- "$_trimmed_violations" >/dev/null 2>&1; then
          warn "plan-write wrote plan to wrong path: ${_trimmed_violations} -- moving to plan.md"
          emit_event "plan-write" "warn" "plan_written.removed_mispath" \
            "auto-remediated mispathed plan" src="${_trimmed_violations}"
          mv "$_v_file" "${WORKTREE_DIR}/plan.md"
          local _wt_norm="${WORKTREE_DIR%/}"
          local _v_dir
          _v_dir=$(dirname "$_v_file")
          while [[ "${_v_dir%/}" != "$_wt_norm" && -d "$_v_dir" ]] ; do
            rmdir "$_v_dir" 2>/dev/null || break
            _v_dir=$(dirname "$_v_dir")
          done
          _all_violations=""
        fi
      fi
    fi
  fi
}
