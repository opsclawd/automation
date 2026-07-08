#!/usr/bin/env bash
# scripts/lib/artifacts.sh
#
# Centralized artifact path list and guard operations for defense-in-depth
# against orchestrator artifacts entering git commits (#280).
#
# This file is the canonical source of truth for "which files at the worktree
# root are orchestrator artifacts that must never be tracked."  Other sites
# (.gitignore, seed_excludes, triage prompt skip rules) refer back here.
#
# Required dependencies (must be defined by caller):
#   warn()          — log a warning to stderr
#   emit_event()    — emit a structured event for telemetry
#   orchestrator_fail() — abort the run with a failure message

# orchestrator_artifact_paths
#
# Returns the canonical list of known root-level orchestrator artifacts, one
# per line.  These are exact filenames — the files that, if tracked by git,
# will break read-only phase mutation guards when rewritten every run.
#
# Globs (*.log, *.result) are NOT listed here because:
#   (a) The git diff pathspec exclusions need exact names
#   (b) .gitignore and info/exclude already provide ubiquitous coverage
orchestrator_artifact_paths() {
  cat << 'EOF'
validation.headsha
review-fix-plan.json
review-task-manifest.json
review-triage.md
code-review.md
review.md
task-manifest.json
arbiter-result.json
review-loop-history.json
implement-step-history-*.json
compound-draft.md
validation.result
result.json
fix-validate-done.marker
plan-review-passed.marker
EOF
}

# orchestrator_diff_exclusions
#
# Emits git pathspec exclusion arguments for each known artifact so
# mutation guards can ignore them.  Output is one exclusion per line
# in the form ':!filename', suitable for `mapfile -t` or while-read.
orchestrator_diff_exclusions() {
  while IFS= read -r _artifact; do
    [[ -z "$_artifact" ]] && continue
    printf '%s\n' ":!${_artifact}"
  done < <(orchestrator_artifact_paths)
}

# guard_artifact_clean <worktree_dir> [base_branch]
#
# Post-phase artifact remediation.  Handles three states for each known
# artifact:
#   1. Untracked/uncommitted → rm -f
#   2. Staged but not committed → git reset HEAD -- + rm -f
#   3. Committed to branch      → git rm -f -- + git commit --only
#
# State 3 requires base_branch (origin/<name>) to detect branch commits.
# When omitted, only states 1 and 2 are handled.
guard_artifact_clean() {
  local worktree_dir=$1
  local base_branch=${2:-}

  local _artifact _committed_any=0
  local -a _removed_artifacts=()

  while IFS= read -r _artifact; do
    [[ -z "$_artifact" ]] && continue

    local -a _resolved_artifacts=()
    if [[ "$_artifact" == *"*"* ]]; then
      local _f
      for _f in "${worktree_dir}"/$_artifact; do
        if [[ -f "$_f" ]]; then
          _resolved_artifacts+=("$(basename "$_f")")
        fi
      done
      while IFS= read -r _f; do
        [[ -n "$_f" ]] && _resolved_artifacts+=("$_f")
      done < <(
        {
          git -C "$worktree_dir" ls-files -- "$_artifact" 2>/dev/null
          git -C "$worktree_dir" diff --cached --name-only -- "$_artifact" 2>/dev/null
          if [[ -n "$base_branch" ]]; then
            git -C "$worktree_dir" diff "${base_branch}..HEAD" --name-only -- "$_artifact" 2>/dev/null
          fi
        } | sort -u
      )
    else
      _resolved_artifacts+=("$_artifact")
    fi

    local -a _unique_resolved=()
    if [[ ${#_resolved_artifacts[@]} -gt 0 ]]; then
      while IFS= read -r _f; do
        [[ -n "$_f" ]] && _unique_resolved+=("$_f")
      done < <(printf '%s\n' "${_resolved_artifacts[@]}" | sort -u)
    fi

    local _res_art
    for _res_art in "${_unique_resolved[@]}"; do
      # 1. Untracked / uncommitted: just delete it (if not tracked by git).
      if ! git -C "$worktree_dir" ls-files --error-unmatch -- "$_res_art" >/dev/null 2>&1; then
        rm -f "${worktree_dir}/${_res_art}"
      fi

      # 2. Staged but not committed: unstage and delete.
      if git -C "$worktree_dir" diff --cached --name-only 2>/dev/null | grep -qxF "$_res_art"; then
        git -C "$worktree_dir" reset HEAD -- "$_res_art" 2>/dev/null || true
        rm -f "${worktree_dir}/${_res_art}"
      fi

      # 3. Already committed to the branch.
      if [[ -n "$base_branch" ]]; then
        if git -C "$worktree_dir" diff "${base_branch}..HEAD" --name-only 2>/dev/null | grep -qxF "$_res_art"; then
          if git -C "$worktree_dir" rm -f -- "$_res_art" 2>/dev/null; then
            _committed_any=1
            _removed_artifacts+=("$_res_art")
          fi
        fi
      fi
    done
  done < <(orchestrator_artifact_paths)

  if [[ $_committed_any -eq 1 ]]; then
    git -C "$worktree_dir" commit --only -m "fix: remove orchestrator artifacts that were committed by agent" -- "${_removed_artifacts[@]}" 2>/dev/null || true
    if declare -F warn >/dev/null 2>&1; then
      warn "guard_artifact_clean: removed one or more committed orchestrator artifacts"
    fi
    if declare -F emit_event >/dev/null 2>&1; then
      emit_event "" "warn" "artifact.committed_removed" \
        "guard_artifact_clean removed committed orchestrator artifact(s)"
    fi
  fi
}
