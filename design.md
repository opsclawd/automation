# M2-03: Instrument `ai-pr-review-poll` with Structured Poll Events

## Problem

The PR review poller (`scripts/ai-pr-review-poll`) runs as a background `nohup` child process spawned by `ai-run-issue-v2`. While it writes to `poll.log`, there is no structured event trail for orchestrator visibility. This means:

1. **No terminal event per run.** The orchestrator cannot determine when or how the poller finished (success, failure, blocked) from the events file alone.
2. **No per-iteration telemetry.** Each poll iteration's progress (comments fetched, agent invocations, verification outcomes) is invisible to the event consumer.
3. **No per-comment trace.** When the agent processes multiple review comments in one iteration, there is no structured record of which comments were seen, which were processed, and what happened for each.
4. **Env var propagation gap.** `AI_RUN_EVENTS_FILE` and `AI_RUN_DISPLAY_ID` are inherited from the parent's environment but `nohup` does not guarantee environment forwarding on all platforms. The poller must receive these explicitly.

The `emit_event.sh` helper (M2-01) already provides the structured JSON-line protocol. M2-02 added events to the issue-to-PR script. This issue closes the gap by instrumenting the poller with the same pattern.

## Why It Matters

- **Observability:** A structured event trail lets the orchestrator surface a complete timeline of what each poll did — comment fetches, agent invocations, reply posts, verification results — in the UI (M6-06).
- **Debugging:** When a poller run fails or stalls, the event file provides a machine-readable audit trail instead of requiring log grepping.
- **Terminal events:** Exactly one `run.completed` or `run.failed` event per invocation is the contract that allows downstream systems to know when a poller run finished and why, without parsing unstructured logs.

## Design Decisions

### Decision 1: Insert `emit_event` calls inline vs. wrap in helper functions

**Chosen: Inline `emit_event` calls with a single `_now_ms` timing helper.**

Alternatives considered:
- **Wrapper functions** (`_emit_poll_started`, `_emit_agent_started`, etc.): Cleaner call sites, but adds 10+ small functions for thin wrappers around `emit_event`. The poller is 800+ lines; adding another ~40 lines of one-line wrappers is low value given `emit_event` is already a clear call pattern.
- **Inline calls**: Matches the M2-02 pattern used in `ai-run-issue-v2`. Keeps the instrumentation visible at the instrumentation site. The `_now_ms` helper is needed for duration tracking and is already established in `ai-run-issue-v2`.

**Rationale:** Consistency with the existing `ai-run-issue-v2` pattern where `_now_ms` + direct `emit_event` calls are used. No new abstraction layer needed.

### Decision 2: Env var propagation via prefix on the spawn line vs. exporting in the parent

**Chosen: Prefix on the `nohup` spawn line.**

Alternatives considered:
- **`export` in parent before `nohup`**: `nohup` + background (`&`) on some shells/platforms may not inherit all exported vars. Explicit prefixing guarantees the child sees them.
- **Write to a temp file, have the poller source it**: Adds complexity and a new file contract. The prefix approach is one line and is standard Bash practice for `nohup` env propagation.

**Rationale:** The issue explicitly requires this pattern. It's the simplest and most reliable way to propagate env vars across a `nohup` boundary.

### Decision 3: What constitutes a "terminal event" and when `poll.completed` is omitted

**Chosen: Terminal events (`run.completed` / `run.failed`) take the place of `poll.completed` for the final iteration.**

The loop structure is:
```
while [[ $POLL_COUNT -lt $MAX_POLLS && ... ]]; do
  emit poll.started
  ... do work ...
  if terminal_condition_met; then
    emit run.completed/run.failed
    break/exit
  fi
  emit poll.completed
  sleep
done
# After loop exhaustion: emit run.failed
```

**Rationale:** This avoids emitting both `poll.completed` and `run.completed` on the final iteration, which would create ambiguity about whether the iteration was "normal" or "terminal." The acceptance criteria (AC1, AC2) explicitly state that the final iteration omits `poll.completed` in favor of the terminal event.

### Decision 4: Variable naming for metadata

**Chosen: Use the actual variable names in the poller script, confirmed by code analysis.**

Key mappings:
- `POLL_COUNT` (loop counter, 1-indexed) → `poll` metadata
- `MAX_POLLS` (parameter, default 3) → `maxPolls` metadata
- `PR_NUMBER` (positional arg 1) → `prNumber` metadata
- `comment_count` (derived from `jq 'length'` on filtered comments) → `total` / `unprocessed` metadata
- `review_result` (from `resolve_result`) → `result` metadata
- `PROCESSED_IDS_FILE` / `REPLIED_IDS_FILE` line counts → `processed` / `pending` metadata

**Rationale:** The comment plan references variable names like `AGENT_EXIT`, `REPLY_EXIT`, `UNPROCESSED_IDS`. Actual code analysis of `ai-pr-review-poll` shows these don't exist as written. The real variable names are different (`review_ec` instead of agent exit code, no explicit `UNPROCESSED_IDS` variable — the script uses `comment_count` and the `comments` JSON array). The design must use the actual names found in the code.

### Decision 5: Where to place timing for agent duration

**Chosen: Capture `_now_ms` immediately before the agent invocation and compute delta immediately after.**

The agent `run_agent` function captures its own exit code via a temp file. The duration must bracket just the agent call, not the verification chain that follows. The `AGENT_START_MS` variable will be set right before `run_agent` and the delta computed from `_now_ms` immediately after, before any verification logic.

**Rationale:** Agent duration is the time the AI spends processing comments. If we bracket verification too, the duration becomes meaningless for understanding agent performance.

### Decision 6: How to handle the `nohup` exit codes for `run.failed`

**Chosen: Two terminal exit paths: loop exhaustion (`MAX_POLLS` / `MAX_TOTAL_POLLS`) and `BLOCKED` result.**

The poller has two failure modes:
1. **Loop exhaustion**: `POLL_COUNT >= MAX_POLLS || TOTAL_POLLS >= MAX_TOTAL_POLLS` — the while loop exits normally and we emit `run.failed` with `reason=max_polls` or `reason=max_total_polls`.
2. **BLOCKED result**: When `resolve_result` returns `BLOCKED` — we emit `run.failed` with `reason=BLOCKED` and exit.

Success paths:
- `ALL_DONE`: Agent processed everything and verification passed.
- `NO_FIXES_NEEDED`: Agent assessed all comments as invalid and verification passed.

**Rationale:** The acceptance criteria (AC6) requires `run.failed` with `metadata.reason == "BLOCKED"`. Loop exhaustion is the other failure path. Both must produce `run.failed`.

## Proposed Approach

### 1. Propagate env vars at spawn site (`ai-run-issue-v2`)

Change line 1916 from:
```bash
nohup "${REPO_ROOT}/scripts/ai-pr-review-poll" "$PR_NUM_VALUE" "$ISSUE_NUM" 3 300 \
```
to:
```bash
AI_RUN_EVENTS_FILE="${AI_RUN_EVENTS_FILE:-}" \
AI_RUN_DISPLAY_ID="${AI_RUN_DISPLAY_ID:-}" \
nohup "${REPO_ROOT}/scripts/ai-pr-review-poll" "$PR_NUM_VALUE" "$ISSUE_NUM" 3 300 \
```

This ensures the poller receives the event file path and display ID even when launched via `nohup`.

### 2. Add `_now_ms` helper to poller

Insert after `source emit_event.sh` (line 51):
```bash
_HAS_NANOSECONDS=false
if date +%N >/dev/null 2>&1 && [[ "$(date +%N)" != "N" ]]; then
  _HAS_NANOSECONDS=true
fi
_now_ms() {
  if [[ "$_HAS_NANOSECONDS" == "true" ]]; then
    echo $(( $(date +%s%N) / 1000000 ))
  else
    echo $(( $(date +%s) * 1000 ))
  fi
}
```

This mirrors the exact pattern from `ai-run-issue-v2` (lines 75-85).

### 3. Instrument the main poll loop

The main loop (lines 777-814) uses `while [[ $POLL_COUNT -lt $MAX_POLLS && $TOTAL_POLLS -lt $MAX_TOTAL_POLLS ]]`. Instrumentation points:

**Top of loop iteration** — after `POLL_COUNT`/`TOTAL_POLLS` increment (line 789-790):
```bash
emit_event "pr-review-poll" "info" "pr-review-poll.poll.started" \
  "poll ${POLL_COUNT}/${MAX_POLLS} for PR #${PR_NUMBER}" \
  prNumber="$PR_NUMBER" poll="$POLL_COUNT" maxPolls="$MAX_POLLS"
```

**After comments fetched and filtered** — inside `process_reviews`, after line 522 (`comment_count` is computed), and after the `UNPROCESSED_IDS`-equivalent filtering. The variable `comment_count` represents the unprocessed comments after filtering.

The `process_reviews` function is complex. Rather than trying to emit per-comment events deep inside it, the design takes a simpler approach:

### 4. Instrument `process_reviews` function

This is the most complex instrumentation site. The function currently returns exit codes (0=success, 1=no reviews, 2=verification failed). Rather than restructuring it, the design adds events at key points:

**Comments fetched** — after line 523 (where `comment_count` is derived):
```bash
emit_event "pr-review-poll" "info" "pr-review-poll.poll.comments.fetched" \
  "fetched comments, ${comment_count} unprocessed" \
  total="$comment_count" unprocessed="$comment_count"
```

Note: `comment_count` is already the *unprocessed* count after filtering. The "total" metadata should ideally be the raw count before filtering, but `all_comments` count is computed at line 522. The simplest approach: emit the event right after both `all_comments` and `comments` variables are available, using `all_comments | jq 'length'` for total and `comment_count` for unprocessed.

**Agent invocation** — around `run_agent "process-review-p${POLL_COUNT}" 600 < "$prompt_file"` (line 670):
```bash
AGENT_START_MS=$(_now_ms)
emit_event "pr-review-poll" "info" "pr-review-poll.agent.started" \
  "invoking agent for poll iteration ${POLL_COUNT}" commentId="batch-p${POLL_COUNT}"
```

After agent invocation:
```bash
AGENT_DUR=$(( $(_now_ms) - AGENT_START_MS ))
local result_val
result_val=$(resolve_result ...)
if [[ "$result_val" == "ALL_DONE" || "$result_val" == "NO_FIXES_NEEDED" || "$result_val" == "PARTIAL" ]]; then
  emit_event "pr-review-poll" "info" "pr-review-poll.agent.completed" \
    "agent completed for poll iteration ${POLL_COUNT}: ${result_val}" \
    commentId="batch-p${POLL_COUNT}" result="$result_val" durationMs="$AGENT_DUR"
elif [[ "$result_val" == "BLOCKED" ]]; then
  emit_event "pr-review-poll" "error" "pr-review-poll.agent.failed" \
    "agent blocked for poll iteration ${POLL_COUNT}" \
    commentId="batch-p${POLL_COUNT}" reason="BLOCKED" exitCode="$agent_ec"
else
  emit_event "pr-review-poll" "error" "pr-review-poll.agent.failed" \
    "agent for poll iteration ${POLL_COUNT} produced invalid result: ${result_val}" \
    commentId="batch-p${POLL_COUNT}" reason="invalid_result" exitCode="$agent_ec"
fi
```

**Important note on `commentId`**: The issue spec says `commentId` should be per-comment. However, the poller processes all unprocessed comments in a single batch, not per-comment. The `process_reviews` function feeds all unprocessed comments to the agent at once. This means:
- The `commentId` metadata for agent events will be "batch-p{N}" rather than a real comment ID, since the agent processes a batch.
- Per-comment `reply.posted` / `verification.passed` / `verification.failed` events are emitted inside the per-comment verification logic (which does iterate over individual comment IDs via `verify_replies_posted`).

This is a pragmatic adaptation: the poller's architecture already batches comments. The agent processes them as a batch, so agent events reflect that. Verification and reply events can still be per-comment where the code iterates by ID.

### 5. Verification and reply events

**Reply verification** — after `verify_replies_posted` (called at lines 718, 721, 729):
```bash
if verify_replies_posted; then
  emit_event "pr-review-poll" "info" "pr-review-poll.reply.posted" \
    "replies confirmed for batch p${POLL_COUNT}"
  replies_ok=true
else
  emit_event "pr-review-poll" "error" "pr-review-poll.reply.failed" \
    "reply verification failed for batch p${POLL_COUNT}" error="verify_replies_failed"
  verify_ok=false
fi
```

**Build verification** — after `verify_build_passes`:
```bash
if verify_build_passes; then
  emit_event "pr-review-poll" "info" "pr-review-poll.verification.passed" \
    "verification passed for batch p${POLL_COUNT}"
else
  emit_event "pr-review-poll" "error" "pr-review-poll.verification.failed" \
    "verification failed for batch p${POLL_COUNT}" reason="build_or_commits_failed"
fi
```

### 6. Terminal events

**Success** — where `process_reviews` returns 0 and the loop exits naturally after `ALL_DONE`:
```bash
# After loop ends with successful processing
TOTAL_PROCESSED=$(wc -l < "$PROCESSED_IDS_FILE" 2>/dev/null | tr -d ' ')
emit_event "pr-review-poll" "info" "pr-review-poll.run.completed" \
  "PR review poll finished" \
  totalProcessed="${TOTAL_PROCESSED:-0}" terminalReason="ALL_DONE"
```

**Failure — loop exhaustion** — when `POLL_COUNT >= MAX_POLLS` or `TOTAL_POLLS >= MAX_TOTAL_POLLS`:
```bash
if [[ $POLL_COUNT -ge $MAX_POLLS || $TOTAL_POLLS -ge $MAX_TOTAL_POLLS ]]; then
  emit_event "pr-review-poll" "error" "pr-review-poll.run.failed" \
    "PR review poll exhausted budget" \
    reason="max_polls" lastPoll="$POLL_COUNT"
```

**Failure — BLOCKED** — inside `process_reviews` where `review_result == "BLOCKED"` (line 723 area):
```bash
emit_event "pr-review-poll" "error" "pr-review-poll.run.failed" \
  "Agent blocked" reason="BLOCKED" lastPoll="$POLL_COUNT"
```

### 7. Poll iteration completion event

At the end of each non-terminal iteration, before `sleep`:
```bash
PROCESSED_COUNT=$(wc -l < "$PROCESSED_IDS_FILE" 2>/dev/null | tr -d ' ')
PENDING_COUNT=0
if [[ -s "$REPLIED_IDS_FILE" ]]; then
  PENDING_COUNT=$(wc -l < "$REPLIED_IDS_FILE" | tr -d ' ')
fi
emit_event "pr-review-poll" "info" "pr-review-poll.poll.completed" \
  "poll ${POLL_COUNT} complete" \
  poll="$POLL_COUNT" processed="${PROCESSED_COUNT:-0}" pending="$PENDING_COUNT"
```

### 8. bats test suite

Create `scripts/lib/__tests__/poll_events.bats` with:
- Happy-path test: 3-poll iteration with expected event types, asserting exactly one terminal event.
- Blocked-path test: `run.failed` with `reason == "BLOCKED"`.
- Event metadata assertions for key fields.

## Assumptions

1. **The poller runs as a `nohup` child of `ai-run-issue-v2`.** The spawn site is at line 1916 and only appears once. If other spawn sites are added in the future, they would also need the env var prefix.

2. **The `process_reviews` function processes comments as a batch, not per-comment.** This means `agent.started`/`agent.completed` events use `commentId="batch-p{N}"` rather than a real GitHub comment ID. This differs from the issue spec's per-comment `commentId`, but reflects the actual architecture. Per-comment granularity exists at the verification/reply level.

3. **`POLL_COUNT` is 1-indexed.** Confirmed by the `POLL_COUNT=$((POLL_COUNT + 1))` at line 789, which happens before the `process_reviews` call. The first iteration has `POLL_COUNT=1`.

4. **`PROCESSED_IDS_FILE` and `REPLIED_IDS_FILE` are reliable counters.** `wc -l` on these files gives the number of processed and pending comment IDs respectively. Empty files yield `0` after the `| tr -d ' '` pipeline.

5. **`emit_event` is no-fail.** It returns 0 even when `AI_RUN_EVENTS_FILE` is unset (no-op) or when the write fails (warns to stderr). This matches the issue's implementation note. Adding `emit_event` calls will not break `set -uo pipefail` behavior.

6. **The `_now_ms` helper in `ai-run-issue-v2` is canonical.** The same implementation (nanosecond detection + fallback) should be copied to `ai-pr-review-poll`.

7. **The `review_ec` return value from `process_reviews` drives terminal logic.** Return code 0 = success, 1 = no new reviews (continue polling), 2 = verification failure (continue polling). The outer loop doesn't break on success — it only breaks on `POLL_COUNT >= MAX_POLLS` or `TOTAL_POLLS >= MAX_TOTAL_POLLS`.

## In Scope

- Propagate `AI_RUN_EVENTS_FILE` and `AI_RUN_DISPLAY_ID` at the `nohup` spawn site in `ai-run-issue-v2`
- Add `_now_ms` timing helper to `ai-pr-review-poll`
- Insert `emit_event` calls for all events in the vocabulary table
- Create `scripts/lib/__tests__/poll_events.bats` with golden-trace tests
- Verify both scripts pass `bash -n` syntax check
- Verify bats suite passes via `pnpm test:bash`

## Out of Scope

- Replacing `nohup` with a managed job system (M6-04)
- PR review domain tables (M6-01)
- UI surfacing of poll events (M6-06)
- Refactoring `process_reviews` to process comments individually
- Changing the poller's batch-processing architecture

## Risks and Concerns

1. **Batch vs. per-comment `commentId`**: The issue spec says `agent.started` should have `commentId` per comment, but the poller processes comments as a batch. Using `"batch-p{N}"` is pragmatic but diverges from the spec. If per-comment events are needed later, `process_reviews` would need restructuring into a per-comment loop.

2. **Exit-code loss in terminal event emission**: The poller uses `set -uo pipefail` (no `-e`). When the script is about to `exit 1`, the `emit_event` call must succeed before the exit. Since `emit_event` is no-fail and appends synchronously, this is safe. But we must ensure `emit_event` is called *before* the `exit` statement, not after.

3. **Loop structure complexity**: The main loop has two exit conditions (`POLL_COUNT >= MAX_POLLS` and `TOTAL_POLLS >= MAX_TOTAL_POLLS`) and the `process_reviews` function can `exit 0` on "PR already merged" (line 480). The "PR already merged" early exit should emit `run.completed` with a terminal reason, since it's a clean completion.

4. **`comment_count` represents filtered (unprocessed) count, not total**: The total comment count (`all_comments | jq 'length'`) is not computed anywhere currently. We need to add it. This requires a small addition to compute `TOTAL_COMMENT_COUNT` before filtering.

5. **`process_reviews` can `exit 0` (line 480)**: If the PR is already merged, the poller exits silently. This should emit `run.completed` with `terminalReason=already_merged` before exiting.

6. **`nohup` env propagation has been verified**: The `BASH_ENV` variable and standard `env` prefix are reliable for Bash scripts. The explicit `AI_RUN_EVENTS_FILE=... AI_RUN_DISPLAY_ID=... nohup ...` pattern is the recommended approach per Bash manual.

7. **Test fidelity**: The bats test suite tests event emission in isolation (sourcing `emit_event.sh` and calling it directly). It does not run the actual poller script. This is sufficient for verifying the event vocabulary and structure but cannot verify that events are emitted at the correct points in the poller's control flow. Integration testing would require mocking `gh`, `git`, and `opencode` commands.