#!/usr/bin/env bash
# scripts/lib/guard-main-checkout.sh
#
# Shared main-checkout leak guard. Source this from orchestrator scripts
# that invoke agents which might write into the main checkout.
#
# Required dependencies (must be defined by caller before sourcing):
#   warn()     — log a warning message to stderr
#   emit_event() — emit a structured event for telemetry (guard_label + event_type)
#
# Required env vars (set by caller before sourcing):
#   REPO_ROOT  — absolute path to the main git checkout
#
# The no-op check uses WORKTREE_DIR (ai-run-issue-v2) or POLL_WORKTREE
# (ai-pr-review-poll) to detect "running without worktrees."

_guard_worktree_dir() {
  if [[ -n "${WORKTREE_DIR:-}" ]]; then
    printf '%s' "$WORKTREE_DIR"
  elif [[ -n "${POLL_WORKTREE:-}" ]]; then
    printf '%s' "$POLL_WORKTREE"
  else
    printf ''
  fi
}

_capture_worktree_state() {
  local _worktree
  _worktree=$(_guard_worktree_dir)
  if [[ -z "$_worktree" ]]; then
    echo "ERROR: _capture_worktree_state: WORKTREE_DIR is unset" >&2
    return 1
  fi
  local sha was_dirty=0 branch
  sha=$(git -C "$_worktree" rev-parse HEAD 2>/dev/null || echo "")
  branch=$(git -C "$_worktree" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "HEAD")
  if ! git -C "$_worktree" diff --quiet 2>/dev/null \
     || ! git -C "$_worktree" diff --cached --quiet 2>/dev/null \
     || git -C "$_worktree" status --porcelain 2>/dev/null | grep -q '^??'; then
    was_dirty=1
  fi
  printf '%s|%s|%s' "$sha" "$was_dirty" "$branch"
}

_guard_worktree() {
  local guard_label="${1:-agent}"
  local pre_state="${2:-}"
  local _worktree
  _worktree=$(_guard_worktree_dir)
  if [[ -z "$_worktree" ]]; then
    warn "ERROR: _guard_worktree: WORKTREE_DIR is unset — cannot guard, every run should have a worktree"
    return 1
  fi

  local expected_sha="" pre_was_dirty=0 pre_branch=""
  if [[ -n "$pre_state" ]]; then
    IFS='|' read -r expected_sha pre_was_dirty pre_branch <<< "$pre_state"
  fi

  local actual_sha=""
  actual_sha=$(git -C "$_worktree" rev-parse HEAD 2>/dev/null || echo "")

  local _moved=0
  if [[ -n "$expected_sha" && -n "$actual_sha" && "$actual_sha" != "$expected_sha" ]]; then
    _moved=1
  fi

  local _dirty=0
  if ! git -C "$_worktree" diff --quiet 2>/dev/null; then _dirty=1; fi
  if ! git -C "$_worktree" diff --cached --quiet 2>/dev/null; then _dirty=1; fi
  if git -C "$_worktree" status --porcelain 2>/dev/null | grep -q '^??'; then _dirty=1; fi

  if [[ $_moved -eq 1 ]]; then
    if [[ $pre_was_dirty -eq 1 ]]; then
      warn "Worktree HEAD moved after ${guard_label} (${expected_sha:0:7} → ${actual_sha:0:7}) AND was dirty pre-agent — refusing to auto-reset; manual cleanup required"
      warn "  pre-agent SHA: ${expected_sha}"
      warn "  leaked SHA:    ${actual_sha}"
      warn "  inspect with:  git -C ${_worktree} log --oneline ${expected_sha}..${actual_sha}"
      emit_event "${guard_label}" "error" "${guard_label}.worktree_leak_unsafe_recovery" \
        "Agent committed to worktree while pre-agent state was dirty; manual cleanup required" \
        pollIteration="${POLL_COUNT:-0}" \
        expectedSha="$expected_sha" actualSha="$actual_sha"
      return 0
    fi
    # ── Clean commit: HEAD advanced but tree is clean ──────────────
    # This is expected committed work (implement phase, fix phase,
    # code-review phase, etc.). Do not treat as a leak — no fail,
    # no reset. Branch-switch check below still applies.
    if [[ $_dirty -eq 0 ]]; then
      emit_event "${guard_label}" "info" "${guard_label}.worktree_commit_detected" \
        "Commit detected in worktree (${expected_sha:0:7} → ${actual_sha:0:7}); tree is clean — not a leak" \
        pollIteration="${POLL_COUNT:-0}" \
        expectedSha="$expected_sha" actualSha="$actual_sha"
    else
      _guard_fail_or_warn "leak detected: worktree HEAD moved from ${expected_sha:0:7} to ${actual_sha:0:7}" "$guard_label" "Worktree guard" || return $?
      warn "Worktree HEAD moved after ${guard_label} (${expected_sha:0:7} → ${actual_sha:0:7}) — resetting to pre-agent SHA"
      if [[ -n "$pre_branch" && "$pre_branch" != "HEAD" ]]; then
        git -C "$_worktree" checkout -q "$pre_branch" 2>/dev/null || true
        local _current_branch
        _current_branch=$(git -C "$_worktree" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "HEAD")
        if [[ "$_current_branch" != "$pre_branch" ]]; then
          warn "Checkout of ${pre_branch} failed after ${guard_label} — refusing to reset to avoid corrupting current branch; manual cleanup required"
          emit_event "${guard_label}" "error" "${guard_label}.worktree_leak_unsafe_recovery" \
            "Agent committed to worktree; failed to restore branch ${pre_branch}; manual cleanup required" \
            pollIteration="${POLL_COUNT:-0}" \
            expectedSha="$expected_sha" actualSha="$actual_sha"
          return 0
        fi
      elif [[ "$pre_branch" == "HEAD" ]]; then
        local _current_branch
        _current_branch=$(git -C "$_worktree" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "HEAD")
        if [[ "$_current_branch" != "HEAD" ]]; then
          warn "Pre-agent was detached (HEAD) but agent left checkout on branch ${_current_branch} after ${guard_label} — refusing to reset to avoid corrupting local branch state; manual cleanup required"
          warn "  inspect with:  git -C ${_worktree} log --oneline ${expected_sha}..${actual_sha}"
          emit_event "${guard_label}" "error" "${guard_label}.worktree_leak_unsafe_recovery" \
            "Agent committed to worktree from detached HEAD; agent left on branch ${_current_branch}; refusing to reset to avoid branch corruption" \
            pollIteration="${POLL_COUNT:-0}" \
            expectedSha="$expected_sha" actualSha="$actual_sha"
          return 0
        fi
      fi
      git -C "$_worktree" reset --hard "$expected_sha" 2>/dev/null || true
      git -C "$_worktree" clean -fd 2>/dev/null || true
      emit_event "${guard_label}" "warn" "${guard_label}.worktree_leak_detected" \
        "Agent leaked commit into worktree; auto-reset to pre-agent SHA" \
        pollIteration="${POLL_COUNT:-0}" \
        expectedSha="$expected_sha" actualSha="$actual_sha"
      return 0
    fi
  fi

  if [[ $_dirty -eq 1 ]]; then
    if [[ $pre_was_dirty -eq 1 ]]; then
      warn "Worktree still dirty after ${guard_label} but was already dirty pre-agent — skipping reset to preserve unrelated local work"
      emit_event "${guard_label}" "info" "${guard_label}.worktree_dirty_preexisting" \
        "Worktree dirty pre-agent; guard skipped to preserve local work" \
        pollIteration="${POLL_COUNT:-0}"
    else
      _guard_fail_or_warn "leak detected: worktree is dirty" "$guard_label" "Worktree guard" || return $?
      warn "Worktree dirty after ${guard_label} — resetting leaked changes"
      git -C "$_worktree" reset --hard HEAD 2>/dev/null || true
      git -C "$_worktree" clean -fd 2>/dev/null || true
      emit_event "${guard_label}" "warn" "${guard_label}.worktree_leak_detected" \
        "Agent leaked changes into worktree; auto-reset" \
        pollIteration="${POLL_COUNT:-0}"
    fi
  fi

  if [[ -n "$pre_branch" ]]; then
    local _current_branch
    _current_branch=$(git -C "$_worktree" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "HEAD")
    if [[ "$_current_branch" != "$pre_branch" ]]; then
      _guard_fail_or_warn "branch switch: worktree switched from ${pre_branch} to ${_current_branch}" "$guard_label" "Worktree guard" || return $?
      if [[ "$pre_branch" == "HEAD" ]]; then
        warn "Worktree switched from detached HEAD to ${_current_branch} after ${guard_label} — restoring detached HEAD"
        git -C "$_worktree" checkout -q --detach HEAD 2>/dev/null || true
      else
        warn "Worktree switched from ${pre_branch} to ${_current_branch} after ${guard_label} — restoring ${pre_branch}"
        git -C "$_worktree" checkout -q "$pre_branch" 2>/dev/null || true
        local _post_restore_branch
        _post_restore_branch=$(git -C "$_worktree" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "HEAD")
        if [[ "$_post_restore_branch" != "$pre_branch" ]]; then
          warn "Checkout of ${pre_branch} failed after ${guard_label} — manual cleanup may be needed"
        fi
      fi
      emit_event "${guard_label}" "warn" "${guard_label}.worktree_branch_restored" \
        "Restored worktree branch from ${_current_branch} to ${pre_branch}" \
        pollIteration="${POLL_COUNT:-0}"
    fi
  fi
}

_capture_main_state() {
  local sha was_dirty=0 branch
  sha=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo "")
  branch=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "HEAD")
  if ! git -C "$REPO_ROOT" diff --quiet 2>/dev/null \
     || ! git -C "$REPO_ROOT" diff --cached --quiet 2>/dev/null \
     || git -C "$REPO_ROOT" status --porcelain 2>/dev/null | grep -q '^??'; then
    was_dirty=1
  fi
  printf '%s|%s|%s' "$sha" "$was_dirty" "$branch"
}

# Internal: call orchestrator_fail if defined, otherwise return 0 (caller handles
# the legacy auto-reset). orchestrator_fail exits in production but returns 1 in
# BATS stubs, so callers MUST propagate: _guard_fail_or_warn ... || return $?
_guard_fail_or_warn() {
  local reason="$1"
  local guard_label="$2"
  local guard_scope="${3:-Main checkout guard}"
  if declare -F orchestrator_fail >/dev/null 2>&1; then
    orchestrator_fail "${guard_scope}: ${reason} (phase: ${guard_label})"
    return 1
  fi
  return 0
}

_guard_main_checkout() {
  local guard_label="${1:-agent}"
  local pre_state="${2:-}"
  local _worktree
  _worktree=$(_guard_worktree_dir)
  if [[ "$_worktree" == "$REPO_ROOT" || -z "$_worktree" ]]; then
    return 0
  fi

  local expected_sha="" pre_was_dirty=0 pre_branch=""
  if [[ -n "$pre_state" ]]; then
    IFS='|' read -r expected_sha pre_was_dirty pre_branch <<< "$pre_state"
  fi

  local actual_sha=""
  actual_sha=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo "")

  local _moved=0
  if [[ -n "$expected_sha" && -n "$actual_sha" && "$actual_sha" != "$expected_sha" ]]; then
    _moved=1
  fi

  local _dirty=0
  if ! git -C "$REPO_ROOT" diff --quiet 2>/dev/null; then _dirty=1; fi
  if ! git -C "$REPO_ROOT" diff --cached --quiet 2>/dev/null; then _dirty=1; fi
  if git -C "$REPO_ROOT" status --porcelain 2>/dev/null | grep -q '^??'; then _dirty=1; fi

  if [[ $_moved -eq 1 ]]; then
    if [[ $pre_was_dirty -eq 1 ]]; then
      warn "Main checkout HEAD moved after ${guard_label} (${expected_sha:0:7} → ${actual_sha:0:7}) AND was dirty pre-agent — refusing to auto-reset; manual cleanup required"
      warn "  pre-agent SHA: ${expected_sha}"
      warn "  leaked SHA:    ${actual_sha}"
      warn "  inspect with:  git -C ${REPO_ROOT} log --oneline ${expected_sha}..${actual_sha}"
      emit_event "${guard_label}" "error" "${guard_label}.main_leak_unsafe_recovery" \
        "Agent committed to main while pre-agent state was dirty; manual cleanup required" \
        pollIteration="${POLL_COUNT:-0}" \
        expectedSha="$expected_sha" actualSha="$actual_sha"
      return 0
    fi
    _guard_fail_or_warn "leak detected: HEAD moved from ${expected_sha:0:7} to ${actual_sha:0:7}" "$guard_label" "Main checkout guard" || return $?
    # ── Legacy auto-reset path ──────────────────────────────────
    # The warn/revert/reset code below is only reached when
    # orchestrator_fail is NOT defined (legacy mode without the
    # orchestrator framework). When orchestrator_fail IS defined:
    #   - Production: orchestrator_fail calls exit(1), so this
    #     code is unreachable (dead).
    #   - BATS tests: the stub returns 1, and || return $?
    #     above short-circuits before reaching here.
    warn "Main checkout HEAD moved after ${guard_label} (${expected_sha:0:7} → ${actual_sha:0:7}) — resetting to pre-agent SHA"
    if [[ -n "$pre_branch" && "$pre_branch" != "HEAD" ]]; then
      git -C "$REPO_ROOT" checkout -q "$pre_branch" 2>/dev/null || true
      local _current_branch
      _current_branch=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "HEAD")
      if [[ "$_current_branch" != "$pre_branch" ]]; then
        warn "Checkout of ${pre_branch} failed after ${guard_label} — refusing to reset to avoid corrupting current branch; manual cleanup required"
        emit_event "${guard_label}" "error" "${guard_label}.main_leak_unsafe_recovery" \
          "Agent committed to main; failed to restore branch ${pre_branch}; manual cleanup required" \
          pollIteration="${POLL_COUNT:-0}" \
          expectedSha="$expected_sha" actualSha="$actual_sha"
        return 0
      fi
    elif [[ "$pre_branch" == "HEAD" ]]; then
      local _current_branch
      _current_branch=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "HEAD")
      if [[ "$_current_branch" != "HEAD" ]]; then
        warn "Pre-agent was detached (HEAD) but agent left checkout on branch ${_current_branch} after ${guard_label} — refusing to reset to avoid corrupting local branch state; manual cleanup required"
        warn "  inspect with:  git -C ${REPO_ROOT} log --oneline ${expected_sha}..${actual_sha}"
        emit_event "${guard_label}" "error" "${guard_label}.main_leak_unsafe_recovery" \
          "Agent committed to main from detached HEAD; agent left on branch ${_current_branch}; refusing to reset to avoid branch corruption" \
          pollIteration="${POLL_COUNT:-0}" \
          expectedSha="$expected_sha" actualSha="$actual_sha"
        return 0
      fi
    fi
    git -C "$REPO_ROOT" reset --hard "$expected_sha" 2>/dev/null || true
    git -C "$REPO_ROOT" clean -fd 2>/dev/null || true
    emit_event "${guard_label}" "warn" "${guard_label}.main_leak_detected" \
      "Agent leaked commit into main checkout; auto-reset to pre-agent SHA" \
      pollIteration="${POLL_COUNT:-0}" \
      expectedSha="$expected_sha" actualSha="$actual_sha"
    return 0
  fi

  if [[ $_dirty -eq 1 ]]; then
    if [[ $pre_was_dirty -eq 1 ]]; then
      warn "Main checkout still dirty after ${guard_label} but was already dirty pre-agent — skipping reset to preserve unrelated local work"
      emit_event "${guard_label}" "info" "${guard_label}.main_dirty_preexisting" \
        "Main checkout dirty pre-agent; guard skipped to preserve local work" \
        pollIteration="${POLL_COUNT:-0}"
    else
      _guard_fail_or_warn "leak detected: working tree is dirty" "$guard_label" "Main checkout guard" || return $?
      # ── Legacy auto-reset path ──────────────────────────────
      # Same as the HEAD-moved block above: this dirty-tree
      # auto-reset is only reachable when orchestrator_fail is
      # not defined. See comment above for the full explanation.
      warn "Main checkout dirty after ${guard_label} — resetting leaked changes"
      git -C "$REPO_ROOT" reset --hard HEAD 2>/dev/null || true
      git -C "$REPO_ROOT" clean -fd 2>/dev/null || true
      emit_event "${guard_label}" "warn" "${guard_label}.main_leak_detected" \
        "Agent leaked changes into main checkout; auto-reset" \
        pollIteration="${POLL_COUNT:-0}"
    fi
  fi

  if [[ -n "$pre_branch" ]]; then
    local _current_branch
    _current_branch=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "HEAD")
    if [[ "$_current_branch" != "$pre_branch" ]]; then
      if [[ "$pre_branch" == "HEAD" ]]; then
        warn "Main checkout switched from detached HEAD to ${_current_branch} after ${guard_label} — restoring detached HEAD"
        git -C "$REPO_ROOT" checkout -q --detach HEAD 2>/dev/null || true
      else
        warn "Main checkout switched from ${pre_branch} to ${_current_branch} after ${guard_label} — restoring ${pre_branch}"
        git -C "$REPO_ROOT" checkout -q "$pre_branch" 2>/dev/null || true
        local _post_restore_branch
        _post_restore_branch=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "HEAD")
        if [[ "$_post_restore_branch" != "$pre_branch" ]]; then
          warn "Checkout of ${pre_branch} failed after ${guard_label} — manual cleanup may be needed"
        fi
      fi
      emit_event "${guard_label}" "warn" "${guard_label}.main_branch_restored" \
        "Restored main checkout branch from ${_current_branch} to ${pre_branch}" \
        pollIteration="${POLL_COUNT:-0}"
    fi
  fi
}

_detach_main_head() {
  local _main_branch
  _main_branch=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "HEAD")
  _ORIGINAL_MAIN_BRANCH="$_main_branch"
  _RESTORE_HEAD_SHA=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo "")
  emit_event "main-checkout" "info" "main.detach" \
    "Detaching REPO_ROOT HEAD (was on ${_main_branch} @ ${_RESTORE_HEAD_SHA:0:7})" \
    originalBranch="$_main_branch" originalSha="$_RESTORE_HEAD_SHA"
  git -C "$REPO_ROOT" checkout -q --detach HEAD 2>/dev/null || {
    warn "Failed to detach REPO_ROOT HEAD from ${_main_branch}"
    return 1
  }
}

_reattach_main_head() {
  if [[ -z "${_ORIGINAL_MAIN_BRANCH:-}" ]]; then
    return 0
  fi
  local _detached_sha
  _detached_sha=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo "")
  if [[ -n "${_RESTORE_HEAD_SHA:-}" && "$_detached_sha" != "$_RESTORE_HEAD_SHA" ]]; then
    warn "REPO_ROOT HEAD advanced while detached (${_RESTORE_HEAD_SHA:0:7} → ${_detached_sha:0:7}) — leak committed; restoration will orphan it"
    emit_event "main-checkout" "warn" "main.detach_head_moved" \
      "HEAD advanced while REPO_ROOT was detached; orphan commit(s) will be garbage collected" \
      restoreSha="$_RESTORE_HEAD_SHA" detachedSha="$_detached_sha"
  fi
  if [[ "$_ORIGINAL_MAIN_BRANCH" == "HEAD" ]]; then
    git -C "$REPO_ROOT" checkout -q --detach "$_RESTORE_HEAD_SHA" 2>/dev/null || {
      warn "Failed to re-detach REPO_ROOT HEAD"
      return 1
    }
  else
    git -C "$REPO_ROOT" checkout -q "$_ORIGINAL_MAIN_BRANCH" 2>/dev/null || {
      warn "Failed to restore REPO_ROOT to branch ${_ORIGINAL_MAIN_BRANCH}"
      return 1
    }
  fi
  local _restored_branch="$_ORIGINAL_MAIN_BRANCH"
  unset _ORIGINAL_MAIN_BRANCH _RESTORE_HEAD_SHA
  emit_event "main-checkout" "info" "main.reattach" \
    "Restored REPO_ROOT branch to ${_restored_branch}" \
    originalBranch="$_restored_branch"
}
