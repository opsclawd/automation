# M2-03: Instrument `ai-pr-review-poll` with Poll Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Insert `emit_event` calls throughout `scripts/ai-pr-review-poll` so each polling iteration produces a structured event trail: poll start, comment fetch, processed-count update, per-comment agent invocation, reply posting, verification, and one terminal event per run.

**Architecture:** The script already runs a poll loop with `MAX_POLLS` iterations. Add a `_emit_poll_*` helper set, then insert calls at the loop boundaries, around `gh` API calls, around the agent invocation per unprocessed comment, around `gh pr review` reply posts, and around the verification step. The `AI_RUN_EVENTS_FILE` and `AI_RUN_DISPLAY_ID` env vars are set by the parent (`ai-run-issue-v2` when it spawns the poller; M1-05 wrapper for direct calls).

**Tech Stack:** Bash 5.x, `jq`, `bats-core`.

---

## Required reading

- `scripts/lib/emit_event.sh` (M2-01).
- `scripts/ai-pr-review-poll` — particularly the main `for ((poll = 1; poll <= MAX_POLLS; poll++))` loop and the per-comment processing block (search `for COMMENT_ID in $UNPROCESSED_IDS` or similar).

---

## Event vocabulary (use exactly these `type` strings)

`phase` is always `"pr-review-poll"`.

| `type`                                 | When                                                  | metadata keys                       |
| -------------------------------------- | ----------------------------------------------------- | ----------------------------------- |
| `pr-review-poll.poll.started`          | Top of each poll iteration                            | `prNumber`, `poll`, `maxPolls`      |
| `pr-review-poll.poll.completed`        | End of one poll iteration (no terminal state)         | `poll`, `processed`, `pending`      |
| `pr-review-poll.poll.comments.fetched` | After `gh api` returns review comments                | `total`, `unprocessed`              |
| `pr-review-poll.agent.started`         | About to invoke receiving-code-review agent           | `commentId`                         |
| `pr-review-poll.agent.completed`       | Agent exits 0 with a recognised result                | `commentId`, `result`, `durationMs` |
| `pr-review-poll.agent.failed`          | Agent timed out, exited non-zero, or wrote bad result | `commentId`, `reason`, `exitCode?`  |
| `pr-review-poll.reply.posted`          | After `gh pr review --reply` succeeds                 | `commentId`, `replyId?`             |
| `pr-review-poll.reply.failed`          | Reply post failed                                     | `commentId`, `error`                |
| `pr-review-poll.verification.passed`   | Verification (commits + build) clean                  | `commentId`                         |
| `pr-review-poll.verification.failed`   | Verification failed                                   | `commentId`, `reason`               |
| `pr-review-poll.run.completed`         | Loop exited with `ALL_DONE` / `NO_FIXES_NEEDED`       | `totalProcessed`, `terminalReason`  |
| `pr-review-poll.run.failed`            | Loop exited because of `BLOCKED` or `MAX_POLLS`       | `reason`, `lastPoll`                |

`level`: success → `info`; failure/timeout → `error`; "we're going to wait and re-poll" → `warn`.

---

## File Structure

- **Modify:** `scripts/ai-pr-review-poll`
- **Modify:** `scripts/ai-run-issue-v2` — wherever it spawns the poller, propagate `AI_RUN_EVENTS_FILE` + `AI_RUN_DISPLAY_ID` (one line change).
- **Create:** `scripts/lib/__tests__/poll_events.bats`

---

## Task 1: Propagate event env from `ai-run-issue-v2` to the poller

**Files:**

- Modify: `scripts/ai-run-issue-v2`

- [ ] **Step 1: Locate the spawn site**

Run:

```bash
grep -n "ai-pr-review-poll\|nohup" scripts/ai-run-issue-v2
```

Find the line that exec's the poller (likely `nohup "${REPO_ROOT}/scripts/ai-pr-review-poll" ...`).

- [ ] **Step 2: Pass the event env vars explicitly**

Modify the spawn line to prefix with the env vars so the child sees them even if launched via `nohup`:

```bash
AI_RUN_EVENTS_FILE="${AI_RUN_EVENTS_FILE:-}" \
AI_RUN_DISPLAY_ID="${AI_RUN_DISPLAY_ID:-}" \
nohup "${REPO_ROOT}/scripts/ai-pr-review-poll" "$PR_NUMBER" "$ISSUE_NUM" ... &
```

Keep the rest of the existing spawn intact.

- [ ] **Step 3: Verify syntax**

Run: `bash -n scripts/ai-run-issue-v2 && echo OK`

- [ ] **Step 4: Commit**

```bash
git add scripts/ai-run-issue-v2
git commit -m "chore(scripts): pass event env vars to PR review poller"
```

---

## Task 2: Add helper section and emit poll boundary events

**Files:**

- Modify: `scripts/ai-pr-review-poll`

- [ ] **Step 1: Add timing helper after the `source emit_event.sh` line**

Insert after the source line (added in M2-01):

```bash
_now_ms() {
  if date +%N >/dev/null 2>&1 && [[ "$(date +%N)" != "N" ]]; then
    echo $(( $(date +%s%N) / 1000000 ))
  else
    echo $(( $(date +%s) * 1000 ))
  fi
}
```

- [ ] **Step 2: Emit `pr-review-poll.poll.started` at top of each iteration**

Locate the poll loop (search `for ((poll`). At the top of the loop body insert:

```bash
emit_event "pr-review-poll" "info" "pr-review-poll.poll.started" \
  "poll ${poll}/${MAX_POLLS} for PR #${PR_NUMBER}" \
  prNumber="$PR_NUMBER" poll="$poll" maxPolls="$MAX_POLLS"
```

- [ ] **Step 3: Emit `pr-review-poll.poll.completed` at the end of each iteration**

At the bottom of the loop body (just before `done` or `sleep`), insert. `PROCESSED_COUNT` and `PENDING_COUNT` may need computation:

```bash
PROCESSED_COUNT=$(wc -l < "$PROCESSED_IDS_FILE" 2>/dev/null || echo 0)
PENDING_COUNT=${UNPROCESSED_COUNT:-0}
emit_event "pr-review-poll" "info" "pr-review-poll.poll.completed" \
  "poll ${poll} complete" \
  poll="$poll" processed="$PROCESSED_COUNT" pending="$PENDING_COUNT"
```

- [ ] **Step 4: Verify + commit**

```bash
bash -n scripts/ai-pr-review-poll && echo OK
git add scripts/ai-pr-review-poll
git commit -m "feat(scripts): emit poll iteration boundary events"
```

---

## Task 3: Emit `comments.fetched` after the GitHub fetch

**Files:**

- Modify: `scripts/ai-pr-review-poll`

- [ ] **Step 1: Locate the comments fetch**

Run:

```bash
grep -n "gh api.*reviews\|gh api.*comments\|gh pr view.*reviews" scripts/ai-pr-review-poll
```

- [ ] **Step 2: Emit after the fetch + filter**

After the line that produces the unprocessed comment ID list (often a variable like `UNPROCESSED_IDS` or similar — `grep` to confirm), add:

```bash
TOTAL_COMMENTS=$(jq '. | length' "${ISSUES_DIR}/reviews.json" 2>/dev/null || echo 0)
UNPROCESSED_COUNT=$(echo "$UNPROCESSED_IDS" | wc -w)
emit_event "pr-review-poll" "info" "pr-review-poll.poll.comments.fetched" \
  "fetched ${TOTAL_COMMENTS} comments, ${UNPROCESSED_COUNT} unprocessed" \
  total="$TOTAL_COMMENTS" unprocessed="$UNPROCESSED_COUNT"
```

Adjust variable names to match the script (`reviews.json`, `comments.json`, `UNPROCESSED_IDS`).

- [ ] **Step 3: Verify + commit**

```bash
bash -n scripts/ai-pr-review-poll && echo OK
git add scripts/ai-pr-review-poll
git commit -m "feat(scripts): emit comments.fetched event"
```

---

## Task 4: Emit agent invocation events per comment

**Files:**

- Modify: `scripts/ai-pr-review-poll`

- [ ] **Step 1: Locate the per-comment processing block**

Search:

```bash
grep -n "for COMMENT_ID\|receiving-code-review\|opencode" scripts/ai-pr-review-poll
```

- [ ] **Step 2: Wrap the agent invocation**

Just BEFORE the line that invokes the agent (e.g. `opencode run ... < "$PROMPT_FILE"`):

```bash
AGENT_START_MS=$(_now_ms)
emit_event "pr-review-poll" "info" "pr-review-poll.agent.started" \
  "invoking agent for comment ${COMMENT_ID}" commentId="$COMMENT_ID"
```

Just AFTER the agent invocation, after `AGENT_EXIT=$?` (or wherever the exit code is captured):

```bash
AGENT_DUR=$(( $(_now_ms) - AGENT_START_MS ))
if [[ $AGENT_EXIT -eq 0 ]]; then
  AGENT_RESULT=$(head -n1 "${ISSUES_DIR}/comment-${COMMENT_ID}.result" 2>/dev/null || echo "UNKNOWN")
  case "$AGENT_RESULT" in
    ALL_DONE|NO_FIXES_NEEDED|PARTIAL|BLOCKED)
      emit_event "pr-review-poll" "info" "pr-review-poll.agent.completed" \
        "agent done for comment ${COMMENT_ID}: ${AGENT_RESULT}" \
        commentId="$COMMENT_ID" result="$AGENT_RESULT" durationMs="$AGENT_DUR"
      ;;
    *)
      emit_event "pr-review-poll" "error" "pr-review-poll.agent.failed" \
        "agent for comment ${COMMENT_ID} produced invalid result: ${AGENT_RESULT}" \
        commentId="$COMMENT_ID" reason="invalid_result" exitCode=0
      ;;
  esac
else
  emit_event "pr-review-poll" "error" "pr-review-poll.agent.failed" \
    "agent for comment ${COMMENT_ID} exited ${AGENT_EXIT}" \
    commentId="$COMMENT_ID" reason="non_zero_exit" exitCode="$AGENT_EXIT"
fi
```

If the script uses different variable names for the result file or exit code, adapt accordingly.

- [ ] **Step 3: Verify + commit**

```bash
bash -n scripts/ai-pr-review-poll && echo OK
git add scripts/ai-pr-review-poll
git commit -m "feat(scripts): emit per-comment agent events"
```

---

## Task 5: Emit reply post + verification events

**Files:**

- Modify: `scripts/ai-pr-review-poll`

- [ ] **Step 1: Locate reply post**

Run:

```bash
grep -n "gh api.*replies\|gh pr review\|reply" scripts/ai-pr-review-poll
```

- [ ] **Step 2: Emit reply events**

After the `gh api ... replies` (or equivalent) call:

```bash
if [[ $REPLY_EXIT -eq 0 ]]; then
  emit_event "pr-review-poll" "info" "pr-review-poll.reply.posted" \
    "reply posted for comment ${COMMENT_ID}" \
    commentId="$COMMENT_ID" replyId="${REPLY_ID:-}"
else
  emit_event "pr-review-poll" "error" "pr-review-poll.reply.failed" \
    "reply post failed for comment ${COMMENT_ID}" \
    commentId="$COMMENT_ID" error="${REPLY_ERROR:-unknown}"
fi
```

(Adjust `REPLY_EXIT`/`REPLY_ID`/`REPLY_ERROR` to match the variables in the script.)

- [ ] **Step 3: Emit verification events**

Locate the verification step (search `verify\|verification` in the script). After it determines pass/fail per comment:

```bash
if [[ $VERIFY_OK -eq 1 ]]; then
  emit_event "pr-review-poll" "info" "pr-review-poll.verification.passed" \
    "verification clean for comment ${COMMENT_ID}" commentId="$COMMENT_ID"
else
  emit_event "pr-review-poll" "error" "pr-review-poll.verification.failed" \
    "verification failed for comment ${COMMENT_ID}" \
    commentId="$COMMENT_ID" reason="${VERIFY_REASON:-unknown}"
fi
```

- [ ] **Step 4: Verify + commit**

```bash
bash -n scripts/ai-pr-review-poll && echo OK
git add scripts/ai-pr-review-poll
git commit -m "feat(scripts): emit reply and verification events"
```

---

## Task 6: Emit terminal `run.completed` / `run.failed`

**Files:**

- Modify: `scripts/ai-pr-review-poll`

- [ ] **Step 1: Identify the terminal exit points**

Search:

```bash
grep -n "ALL_DONE\|NO_FIXES_NEEDED\|BLOCKED\|MAX_POLLS\|exit 0\|exit 1" scripts/ai-pr-review-poll
```

- [ ] **Step 2: Emit completion event on success**

Wherever the script breaks out of the poll loop because the latest result is `ALL_DONE` or `NO_FIXES_NEEDED`, add immediately before the `break` or `exit 0`:

```bash
TOTAL_PROCESSED=$(wc -l < "$PROCESSED_IDS_FILE" 2>/dev/null || echo 0)
emit_event "pr-review-poll" "info" "pr-review-poll.run.completed" \
  "PR review poll finished cleanly" \
  totalProcessed="$TOTAL_PROCESSED" terminalReason="$RESULT"
```

- [ ] **Step 3: Emit failure event on blocked / max-polls**

Wherever the script gives up (after `MAX_POLLS` reached or `BLOCKED`), before `exit 1`:

```bash
emit_event "pr-review-poll" "error" "pr-review-poll.run.failed" \
  "PR review poll terminated without convergence" \
  reason="${TERMINAL_REASON:-max_polls}" lastPoll="$poll"
```

- [ ] **Step 4: Verify + commit**

```bash
bash -n scripts/ai-pr-review-poll && echo OK
git add scripts/ai-pr-review-poll
git commit -m "feat(scripts): emit terminal run events for PR review poller"
```

---

## Task 7: bats test asserting the 3-poll happy trace

**Files:**

- Create: `scripts/lib/__tests__/poll_events.bats`

- [ ] **Step 1: Write the failing test**

```bash
#!/usr/bin/env bats
# Simulate the event trail a 3-iteration poll loop should emit.

setup() {
  TMPDIR_TEST=$(mktemp -d)
  export AI_RUN_EVENTS_FILE="$TMPDIR_TEST/events.jsonl"
  export AI_RUN_DISPLAY_ID="pr-456-review-20260516-130000"
  source "${BATS_TEST_DIRNAME}/../emit_event.sh"
}

teardown() { rm -rf "$TMPDIR_TEST"; }

@test "3-poll happy trace emits exactly one terminal event" {
  for poll in 1 2 3; do
    emit_event "pr-review-poll" info pr-review-poll.poll.started "p $poll" prNumber=456 poll=$poll maxPolls=3
    emit_event "pr-review-poll" info pr-review-poll.poll.comments.fetched "fetched" total=2 unprocessed=$((3-poll))
    emit_event "pr-review-poll" info pr-review-poll.poll.completed "done $poll" poll=$poll processed=$poll pending=$((3-poll))
  done
  emit_event "pr-review-poll" info pr-review-poll.run.completed "done" totalProcessed=3 terminalReason="ALL_DONE"

  run jq -s 'map(select(.type == "pr-review-poll.run.completed" or .type == "pr-review-poll.run.failed")) | length' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
  [ "$output" = "1" ]
}

@test "blocked trace emits run.failed with reason metadata" {
  emit_event "pr-review-poll" info pr-review-poll.poll.started "p 1" prNumber=456 poll=1 maxPolls=3
  emit_event "pr-review-poll" error pr-review-poll.run.failed "blocked" reason="BLOCKED" lastPoll=1
  run jq -s '[.[] | select(.type == "pr-review-poll.run.failed")] | .[0].metadata.reason' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
  [ "$output" = "\"BLOCKED\"" ]
}
```

- [ ] **Step 2: Run + verify**

Run: `pnpm test:bash`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add scripts/lib/__tests__/poll_events.bats
git commit -m "test(scripts): poll event trace tests"
```

---

## Self-Review Notes

- Spec coverage (M2-03 acceptance): "A 3-poll run yields a complete event trail with one terminal event (`run.completed` or `run.failed`)" — covered by bats test in Task 7 and by Tasks 2–6.
- All variable names referenced (`REPLY_EXIT`, `AGENT_EXIT`, `RESULT`, `UNPROCESSED_IDS`, etc.) need to be verified against the actual script during implementation — `grep` first, adapt names.
- The script uses `set -uo pipefail` (no `-e`). `emit_event` is no-fail.
