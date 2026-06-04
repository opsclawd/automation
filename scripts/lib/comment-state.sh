#!/usr/bin/env bash
# scripts/lib/comment-state.sh — Per-comment state machine for PR review poll.
# Sourced by ai-pr-review-poll and by bats tests.
#
# Required env from caller:
#   COMMENT_STATE_FILE — path to ai/poll-pr-<PR>/comment-state.json
#   ISSUES_DIR         — per-PR artifact dir
#   POLL_COUNT          — int, loop iteration count
#   PR_BRANCH           — PR branch name (for commit verification)
#
# State machine:
#   pending ──► replied ──► processed
#      │              │
#      │              └────► pending  (verification failed, retry)
#      └────► blocked  (2 unresolved attempts)

: "${COMMENT_STATE_FILE:=}"
: "${ISSUES_DIR:=}"
: "${POLL_COUNT:=0}"
: "${PR_BRANCH:=}"

init_comment_state() {
  local comment_ids="$1"
  local pre_sha="${2:-}"

  if [[ -z "$COMMENT_STATE_FILE" ]]; then
    warn "init_comment_state: COMMENT_STATE_FILE is unset"
    return 1
  fi

  local new_ids=0
  local fresh_init=false
  if [[ ! -f "$COMMENT_STATE_FILE" ]]; then
    echo '{}' > "$COMMENT_STATE_FILE"
    fresh_init=true
  fi

  # Migrate legacy text-file state into comment-state.json on first init.
  # Without this, previously processed/replied IDs are invisible to the
  # JSON-only filter, causing duplicate agent replies on upgrade.
  if $fresh_init; then
    local migrated=0
    if [[ -n "${PROCESSED_IDS_FILE:-}" && -f "$PROCESSED_IDS_FILE" ]]; then
      local pid
      while IFS= read -r pid; do
        [[ -z "$pid" ]] && continue
        if ! jq -e --arg id "$pid" 'has($id)' "$COMMENT_STATE_FILE" >/dev/null 2>&1; then
          jq --arg id "$pid" --argjson poll "$POLL_COUNT" \
            '.[$id] = {state: "processed", attempts: 1, last_poll: $poll, last_result: "LEGACY_MIGRATION", outcome: "fixed", commit_sha: null, pre_sha: null, reply_verified: true, commit_verified: true, build_verified: true, blocked_reason: null, no_fix_reason: null}' \
            "$COMMENT_STATE_FILE" > "${COMMENT_STATE_FILE}.tmp" && \
            mv "${COMMENT_STATE_FILE}.tmp" "$COMMENT_STATE_FILE"
          migrated=$((migrated + 1))
        fi
      done < "$PROCESSED_IDS_FILE"
    fi
    if [[ -n "${REPLIED_IDS_FILE:-}" && -f "$REPLIED_IDS_FILE" ]]; then
      local rid
      while IFS= read -r rid; do
        [[ -z "$rid" ]] && continue
        if ! jq -e --arg id "$rid" 'has($id)' "$COMMENT_STATE_FILE" >/dev/null 2>&1; then
          jq --arg id "$rid" --argjson poll "$POLL_COUNT" \
            '.[$id] = {state: "replied", attempts: 1, last_poll: $poll, last_result: "LEGACY_MIGRATION", outcome: "no_fix_needed", commit_sha: null, pre_sha: null, reply_verified: true, commit_verified: false, build_verified: false, blocked_reason: null, no_fix_reason: "Migrated from legacy replied tracking; outcome assumed no_fix_needed"}' \
            "$COMMENT_STATE_FILE" > "${COMMENT_STATE_FILE}.tmp" && \
            mv "${COMMENT_STATE_FILE}.tmp" "$COMMENT_STATE_FILE"
          migrated=$((migrated + 1))
        fi
      done < "$REPLIED_IDS_FILE"
    fi
    if [[ $migrated -gt 0 ]]; then
      log "  init_comment_state: migrated ${migrated} legacy id(s) from text files"
    fi
  fi

  if [[ -n "$comment_ids" ]]; then
    local id
    for id in $comment_ids; do
      if ! jq -e --arg id "$id" 'has($id)' "$COMMENT_STATE_FILE" >/dev/null 2>&1; then
        jq --arg id "$id" --argjson poll "$POLL_COUNT" --arg sha "$pre_sha" \
          '.[$id] = {state: "pending", attempts: 0, last_poll: $poll, last_result: null, outcome: null, commit_sha: null, pre_sha: $sha, reply_verified: false, commit_verified: false, build_verified: false, blocked_reason: null, no_fix_reason: null, timeout_count: 0}' \
          "$COMMENT_STATE_FILE" > "${COMMENT_STATE_FILE}.tmp" && \
          mv "${COMMENT_STATE_FILE}.tmp" "$COMMENT_STATE_FILE"
        new_ids=$((new_ids + 1))
      fi
    done
  fi

  if [[ $new_ids -gt 0 ]]; then
    log "  init_comment_state: seeded ${new_ids} new comment(s) as pending"
  fi
}

get_comment_state() {
  local cid="$1"
  jq -r --arg cid "$cid" '.[$cid].state // "pending"' "$COMMENT_STATE_FILE"
}

get_comment_field() {
  local cid="$1"
  local field="$2"
  jq -r --arg cid "$cid" --arg field "$field" '.[$cid][$field] // "null"' "$COMMENT_STATE_FILE"
}

set_comment_state() {
  local cid="$1"
  local state="$2"
  local reason="${3:-}"

  if [[ -z "$COMMENT_STATE_FILE" || ! -f "$COMMENT_STATE_FILE" ]]; then
    warn "set_comment_state: COMMENT_STATE_FILE missing or empty"
    return 1
  fi

  local current_state
  current_state=$(jq -r --arg cid "$cid" '.[$cid].state // "pending"' "$COMMENT_STATE_FILE")
  local attempts
  attempts=$(jq -r --arg cid "$cid" '.[$cid].attempts // 0' "$COMMENT_STATE_FILE")

  if [[ "$state" == "pending" && "$current_state" != "pending" ]]; then
    attempts=$((attempts + 1))
  fi

  jq --arg cid "$cid" --arg state "$state" --argjson attempts "$attempts" \
    --argjson poll "$POLL_COUNT" --arg reason "$reason" \
    '.[$cid].state = $state | .[$cid].attempts = $attempts | .[$cid].last_poll = $poll | .[$cid].blocked_reason = (if $state == "blocked" then $reason else .[$cid].blocked_reason end)' \
    "$COMMENT_STATE_FILE" > "${COMMENT_STATE_FILE}.tmp" && \
    mv "${COMMENT_STATE_FILE}.tmp" "$COMMENT_STATE_FILE"
}

update_comment_outcomes() {
  local outcomes_file="$1"

  if [[ -z "$COMMENT_STATE_FILE" || ! -f "$COMMENT_STATE_FILE" ]]; then
    warn "update_comment_outcomes: COMMENT_STATE_FILE missing"
    return 1
  fi

  if [[ ! -f "$outcomes_file" ]]; then
    log "  update_comment_outcomes: no outcomes file — treating all fed comments as unresolved"
    local pending_ids
    pending_ids=$(jq -r 'to_entries[] | select(.value.state == "pending") | .key' "$COMMENT_STATE_FILE")
    local cid
    for cid in $pending_ids; do
      jq --arg cid "$cid" --argjson poll "$POLL_COUNT" \
        '.[$cid].outcome = "unresolved" | .[$cid].last_result = "MISSING_OUTCOMES" | .[$cid].last_poll = $poll | .[$cid].attempts = ((.[$cid].attempts // 0) + 1)' \
        "$COMMENT_STATE_FILE" > "${COMMENT_STATE_FILE}.tmp" && \
        mv "${COMMENT_STATE_FILE}.tmp" "$COMMENT_STATE_FILE"
    done
    return 0
  fi

  jq -s --argjson poll "$POLL_COUNT" \
    '.[0] as $state | .[1] as $outcomes |
    $state | to_entries | map(
      if ($outcomes[.key] // null) != null then
        .value.outcome = $outcomes[.key].outcome //
          (if .value.outcome == null then "unresolved" else .value.outcome end)
        | .value.last_poll = $poll
        | (if .value.state == "pending" then .value.attempts = ((.value.attempts // 0) + 1) else . end)
        | .value.last_result =
            (if $outcomes[.key].outcome == "fixed" then "ALL_DONE"
             elif $outcomes[.key].outcome == "no_fix_needed" then "NO_FIXES_NEEDED"
             else "UNRESOLVED" end)
        | .value.commit_sha = null
        | .value.no_fix_reason = null
        | .value.commit_sha = ($outcomes[.key].commit_sha // null)
        | .value.no_fix_reason = ($outcomes[.key].reason // null)
        | .value.reply_verified = false
        | .value.commit_verified = false
        | .value.build_verified = false
        | .value.timeout_count = 0
      elif .value.state == "pending" then
        .value.outcome = "unresolved"
        | .value.last_result = "MISSING_OUTCOME"
        | .value.last_poll = $poll
        | .value.attempts = ((.value.attempts // 0) + 1)
        | .value.reply_verified = false
        | .value.commit_verified = false
        | .value.build_verified = false
        | .value.timeout_count = 0
      else . end
    ) | from_entries' \
    "$COMMENT_STATE_FILE" "$outcomes_file" > "${COMMENT_STATE_FILE}.tmp" && \
    mv "${COMMENT_STATE_FILE}.tmp" "$COMMENT_STATE_FILE"

  log "  update_comment_outcomes: merged outcomes from agent manifest"
}

derive_compat_files() {
  if [[ -z "$PROCESSED_IDS_FILE" || -z "$REPLIED_IDS_FILE" ]]; then
    warn "derive_compat_files: PROCESSED_IDS_FILE or REPLIED_IDS_FILE unset"
    return 1
  fi

  : > "$PROCESSED_IDS_FILE"
  : > "$REPLIED_IDS_FILE"

  if [[ -f "$COMMENT_STATE_FILE" ]]; then
    jq -r 'to_entries[] | select(.value.state == "processed") | .key' \
      "$COMMENT_STATE_FILE" >> "$PROCESSED_IDS_FILE"
    jq -r 'to_entries[] | select(.value.state == "replied") | .key' \
      "$COMMENT_STATE_FILE" >> "$REPLIED_IDS_FILE"
  fi
}

check_stuck_comments() {
  local block_threshold="${COMMENT_BLOCK_THRESHOLD:-2}"

  if [[ -z "$COMMENT_STATE_FILE" || ! -f "$COMMENT_STATE_FILE" ]]; then
    return 0
  fi

  local stuck_ids
  # Block any pending comment that has reached the attempt threshold,
  # regardless of outcome. A comment stuck in "pending" after multiple
  # attempts is blocked even if its outcome is "fixed" without a commit_sha
  # or "no_fix_needed" without a reason — these cannot transition to
  # processed and must not loop indefinitely.
  stuck_ids=$(jq -r --argjson threshold "$block_threshold" \
    'to_entries[] | select(.value.state == "pending" and .value.attempts >= $threshold) | .key' \
    "$COMMENT_STATE_FILE")

  for cid in $stuck_ids; do
    [[ -z "$cid" ]] && continue
    local last_result
    last_result=$(jq -r --arg cid "$cid" '.[$cid].last_result // "unknown"' "$COMMENT_STATE_FILE")
    set_comment_state "$cid" "blocked" "Exceeded ${block_threshold} attempts without resolution"
    emit_event "post-pr-review" "error" "post-pr-review.comment.blocked" \
      "Comment ${cid} blocked after ${block_threshold} unresolved attempts" \
      commentId="$cid" attempts="$(jq -r --arg cid "$cid" '.[$cid].attempts' "$COMMENT_STATE_FILE")" lastResult="$last_result"
  done
}

reset_comment_timeout() {
  local cid="$1"
  if [[ -z "$COMMENT_STATE_FILE" || ! -f "$COMMENT_STATE_FILE" ]]; then
    return 1
  fi
  jq --arg cid "$cid" \
    '.[$cid].timeout_count = 0' \
    "$COMMENT_STATE_FILE" > "${COMMENT_STATE_FILE}.tmp" && \
    mv "${COMMENT_STATE_FILE}.tmp" "$COMMENT_STATE_FILE"
}

increment_comment_timeout() {
  local cid="$1"
  if [[ -z "$COMMENT_STATE_FILE" || ! -f "$COMMENT_STATE_FILE" ]]; then
    warn "increment_comment_timeout: COMMENT_STATE_FILE missing"
    return 1
  fi
  jq --arg cid "$cid" --argjson poll "$POLL_COUNT" \
    '.[$cid].timeout_count = ((.[$cid].timeout_count // 0) + 1) | .[$cid].last_poll = $poll' \
    "$COMMENT_STATE_FILE" > "${COMMENT_STATE_FILE}.tmp" && \
    mv "${COMMENT_STATE_FILE}.tmp" "$COMMENT_STATE_FILE"
}

get_timeout_escalation_candidates() {
  local threshold="${1:-2}"
  if [[ -z "$COMMENT_STATE_FILE" || ! -f "$COMMENT_STATE_FILE" ]]; then
    return 0
  fi
  jq -r --argjson threshold "$threshold" \
    'to_entries[] | select(.value.state == "pending" and (.value.timeout_count // 0) >= $threshold) | .key' \
    "$COMMENT_STATE_FILE"
}

verify_comment_commit() {
  local cid="$1"
  local commit_sha="$2"
  local pre_sha="$3"

  if [[ -z "$commit_sha" || "$commit_sha" == *"..."* || ${#commit_sha} -lt 7 ]]; then
    warn "  Comment ${cid}: invalid commit SHA '${commit_sha}'"
    return 1
  fi

  if ! git merge-base --is-ancestor "$commit_sha" "origin/${PR_BRANCH}" 2>/dev/null; then
    warn "  Comment ${cid}: commit ${commit_sha:0:7} not on origin/${PR_BRANCH}"
    return 1
  fi

  if [[ -n "$pre_sha" ]]; then
    local is_newer
    is_newer=$(git rev-list --count "${pre_sha}..${commit_sha}" 2>/dev/null || echo "0")
    if [[ "$is_newer" -eq 0 ]]; then
      warn "  Comment ${cid}: commit ${commit_sha:0:7} is not newer than pre_sha ${pre_sha:0:7}"
      return 1
    fi
  fi

  return 0
}

cleanup_dirty_worktree() {
  local worktree="${1:-$POLL_WORKTREE}"
  local label="p${POLL_COUNT}"
  local diff_file="${ISSUES_DIR}/dirty-worktree-${label}.diff"

  if ! git -C "$worktree" diff --quiet 2>/dev/null || \
     ! git -C "$worktree" diff --cached --quiet 2>/dev/null; then
    {
      git -C "$worktree" diff 2>/dev/null || true
      git -C "$worktree" diff --cached 2>/dev/null || true
    } > "$diff_file" 2>/dev/null || true
    log "  Archived dirty worktree diff to ${diff_file}"
  fi

  git -C "$worktree" reset --hard HEAD 2>/dev/null || true
  git -C "$worktree" clean -fd 2>/dev/null || true
  log "  Restored worktree to clean HEAD"
}

can_transition_to_processed() {
  local cid="$1"

  if [[ -z "$COMMENT_STATE_FILE" || ! -f "$COMMENT_STATE_FILE" ]]; then
    return 1
  fi

  local reply_verified outcome no_fix_reason
  reply_verified=$(jq -r --arg cid "$cid" '.[$cid].reply_verified // false' "$COMMENT_STATE_FILE")

  if [[ "$reply_verified" != "true" ]]; then
    return 1
  fi

  outcome=$(jq -r --arg cid "$cid" '.[$cid].outcome // "null"' "$COMMENT_STATE_FILE")

  if [[ "$outcome" == "fixed" ]]; then
    local commit_sha commit_verified build_verified
    commit_sha=$(jq -r --arg cid "$cid" '.[$cid].commit_sha // "null"' "$COMMENT_STATE_FILE")
    commit_verified=$(jq -r --arg cid "$cid" '.[$cid].commit_verified // false' "$COMMENT_STATE_FILE")
    build_verified=$(jq -r --arg cid "$cid" '.[$cid].build_verified // false' "$COMMENT_STATE_FILE")
    if [[ -z "$commit_sha" || "$commit_sha" == "null" ]]; then
      return 1
    fi
    if [[ "$commit_verified" != "true" ]]; then
      return 1
    fi
    if [[ "$build_verified" != "true" ]]; then
      return 1
    fi
    return 0
  elif [[ "$outcome" == "no_fix_needed" ]]; then
    no_fix_reason=$(jq -r --arg cid "$cid" '.[$cid].no_fix_reason // "null"' "$COMMENT_STATE_FILE")
    if [[ -n "$no_fix_reason" && "$no_fix_reason" != "null" ]]; then
      return 0
    fi
  fi

  return 1
}

