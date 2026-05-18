#!/usr/bin/env bats
# Golden-trace tests for PR review poll event emission.
# Tests the event vocabulary and structure by sourcing emit_event.sh
# directly and calling it with the poll event types.
#
# COVERAGE GAP: These tests validate the event vocabulary and structure
# but do NOT invoke scripts/ai-pr-review-poll itself. They cannot verify
# that events are emitted at the correct points in the poller's control
# flow, that env var propagation works, or that exit paths (BLOCKED,
# PR-already-merged) produce the right terminal events. Integration
# tests mocking gh and opencode would be needed for full coverage.

setup() {
  TMPDIR_TEST=$(mktemp -d)
  export AI_RUN_EVENTS_FILE="$TMPDIR_TEST/events.jsonl"
  export AI_RUN_DISPLAY_ID="pr-456-review-20260516-130000"
  # shellcheck source=../emit_event.sh
  source "${BATS_TEST_DIRNAME}/../emit_event.sh"
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

# Helper: count events of a given type in the events file
_count_type() {
  local type="$1"
  jq -s "[.[] | select(.type == \"$type\")] | length" "$AI_RUN_EVENTS_FILE"
}

# Helper: get metadata value for a specific event type and key
_meta_value() {
  local type="$1" key="$2"
  jq -s "[.[] | select(.type == \"$type\")][0].metadata.$key" "$AI_RUN_EVENTS_FILE"
}

@test "3-poll happy trace emits exactly one terminal event" {
  for poll in 1 2 3; do
    emit_event "pr-review-poll" "info" "pr-review-poll.poll.started" \
      "poll ${poll}/3 for PR #456" prNumber=456 poll=$poll maxPolls=3 totalPolls=$poll maxTotalPolls=30
    emit_event "pr-review-poll" "info" "pr-review-poll.poll.comments.fetched" \
      "fetched comments" total=2 unprocessed=$((4 - poll))
    emit_event "pr-review-poll" "info" "pr-review-poll.agent.started" \
      "invoking agent for poll iteration ${poll}" commentId="batch-p${poll}"
    emit_event "pr-review-poll" "info" "pr-review-poll.agent.completed" \
      "agent done for poll iteration ${poll}: ALL_DONE" \
      commentId="batch-p${poll}" result="ALL_DONE" durationMs=1500
    emit_event "pr-review-poll" "info" "pr-review-poll.reply.posted" \
      "replies confirmed for batch p${poll}" commentId="batch-p${poll}"
    emit_event "pr-review-poll" "info" "pr-review-poll.verification.passed" \
      "commits pushed for batch p${poll}" commentId="batch-p${poll}" step="commits_pushed"
    emit_event "pr-review-poll" "info" "pr-review-poll.verification.passed" \
      "build verification passed for batch p${poll}" commentId="batch-p${poll}" step="build_passes"
    if [[ $poll -lt 3 ]]; then
      emit_event "pr-review-poll" "info" "pr-review-poll.poll.completed" \
        "poll ${poll} complete" poll=$poll processed=$poll pending=$((3 - poll))
    fi
  done
  # Simulate poll.reset event (branch advance)
  emit_event "pr-review-poll" "info" "pr-review-poll.run.completed" \
    "PR review poll finished" totalProcessed=3 terminalReason="ALL_DONE"

  # Exactly one terminal event
  run _count_type "pr-review-poll.run.completed"
  [ "$output" = "1" ]
  run _count_type "pr-review-poll.run.failed"
  [ "$output" = "0" ]

  # Exactly 3 poll.started events
  run _count_type "pr-review-poll.poll.started"
  [ "$output" = "3" ]

  # 2 poll.completed (not 3 — final iteration omits it in favor of run.completed)
  # NOTE: This test constructs its own trace; the actual poller's control flow
  # determines which iterations emit poll.completed. This assertion validates
  # the golden trace, not the poller's runtime behavior.
  run _count_type "pr-review-poll.poll.completed"
  [ "$output" = "2" ]
}

@test "blocked trace emits run.failed with reason BLOCKED" {
  emit_event "pr-review-poll" "info" "pr-review-poll.poll.started" \
    "poll 1/3 for PR #456" prNumber=456 poll=1 maxPolls=3 totalPolls=1 maxTotalPolls=30
  emit_event "pr-review-poll" "info" "pr-review-poll.poll.comments.fetched" \
    "fetched comments" total=1 unprocessed=1
  emit_event "pr-review-poll" "info" "pr-review-poll.agent.started" \
    "invoking agent for poll iteration 1" commentId="batch-p1"
  emit_event "pr-review-poll" "error" "pr-review-poll.agent.failed" \
    "agent blocked for poll iteration 1" \
    commentId="batch-p1" reason="BLOCKED" exitCode=0
  emit_event "pr-review-poll" "error" "pr-review-poll.verification.failed" \
    "agent blocked, skipping verification" \
    commentId="batch-p1" reason="BLOCKED"
  emit_event "pr-review-poll" "error" "pr-review-poll.run.failed" \
    "Agent blocked" reason="BLOCKED" lastPoll=1

  # Exactly one terminal event, and it's run.failed
  run _count_type "pr-review-poll.run.failed"
  [ "$output" = "1" ]
  run _count_type "pr-review-poll.run.completed"
  [ "$output" = "0" ]

  # run.failed has reason=BLOCKED
  run _meta_value "pr-review-poll.run.failed" "reason"
  [ "$output" = '"BLOCKED"' ]
}

@test "max_polls exhaustion emits run.failed with reason max_polls" {
  for poll in 1 2 3; do
    emit_event "pr-review-poll" "info" "pr-review-poll.poll.started" \
      "poll ${poll}/3 for PR #456" prNumber=456 poll=$poll maxPolls=3 totalPolls=$poll maxTotalPolls=30
    emit_event "pr-review-poll" "info" "pr-review-poll.poll.comments.fetched" \
      "no new comments" total=0 unprocessed=0
  done
  emit_event "pr-review-poll" "error" "pr-review-poll.run.failed" \
    "PR review poll exhausted poll budget" reason="max_polls" lastPoll=3

  run _count_type "pr-review-poll.run.failed"
  [ "$output" = "1" ]
  run _meta_value "pr-review-poll.run.failed" "reason"
  [ "$output" = '"max_polls"' ]
}

@test "poll.reset event has previousPollCount and newPollCount" {
  emit_event "pr-review-poll" "info" "pr-review-poll.poll.reset" \
    "poll budget reset due to branch advance" previousPollCount=2 newPollCount=0

  run _meta_value "pr-review-poll.poll.reset" "previousPollCount"
  [ "$output" = '2' ]
  run _meta_value "pr-review-poll.poll.reset" "newPollCount"
  [ "$output" = '0' ]
}

@test "poll.started includes totalPolls and maxTotalPolls" {
  emit_event "pr-review-poll" "info" "pr-review-poll.poll.started" \
    "poll 1/3 for PR #456" prNumber=456 poll=1 maxPolls=3 totalPolls=1 maxTotalPolls=30

  run _meta_value "pr-review-poll.poll.started" "totalPolls"
  [ "$output" = '1' ]
  run _meta_value "pr-review-poll.poll.started" "maxTotalPolls"
  [ "$output" = '30' ]
}

@test "verification.passed events have step metadata" {
  emit_event "pr-review-poll" "info" "pr-review-poll.verification.passed" \
    "commits pushed" commentId="batch-p1" step="commits_pushed"
  emit_event "pr-review-poll" "info" "pr-review-poll.verification.passed" \
    "build passed" commentId="batch-p1" step="build_passes"

  local count
  count=$(jq -s '[.[] | select(.type == "pr-review-poll.verification.passed")] | length' "$AI_RUN_EVENTS_FILE")
  [ "$count" = "2" ]

  local steps
  steps=$(jq -s '[.[] | select(.type == "pr-review-poll.verification.passed") | .metadata.step] | sort | join(",")' "$AI_RUN_EVENTS_FILE")
  [ "$steps" = '"build_passes,commits_pushed"' ]
}

@test "events contain correct phase field" {
  emit_event "pr-review-poll" "info" "pr-review-poll.poll.started" "test" poll=1 maxPolls=3 totalPolls=1 maxTotalPolls=30
  run jq -r '.phase' "$AI_RUN_EVENTS_FILE"
  [ "$output" = "pr-review-poll" ]
}

@test "agent.completed event has durationMs metadata" {
  emit_event "pr-review-poll" "info" "pr-review-poll.agent.completed" \
    "agent done" commentId="batch-p1" result="ALL_DONE" durationMs=2500
  run jq -e '.metadata.durationMs == 2500' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
}

@test "comments.fetched event has total and unprocessed metadata" {
  emit_event "pr-review-poll" "info" "pr-review-poll.poll.comments.fetched" \
    "fetched 5 comments, 2 unprocessed" total=5 unprocessed=2
  run jq -e '.metadata.total == 5 and .metadata.unprocessed == 2' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
}

@test "agent.failed emitted for nonzero agent exit even when resolve_result returns PARTIAL" {
  emit_event "pr-review-poll" "info" "pr-review-poll.agent.started" \
    "invoking agent for poll iteration 1" commentId="batch-p1"
  emit_event "pr-review-poll" "error" "pr-review-poll.agent.failed" \
    "agent for poll iteration 1 exited with code 1" \
    commentId="batch-p1" reason="non_zero_exit" exitCode=1 durationMs=5000

  run _count_type "pr-review-poll.agent.failed"
  [ "$output" = "1" ]
  run _count_type "pr-review-poll.agent.completed"
  [ "$output" = "0" ]

  run _meta_value "pr-review-poll.agent.failed" "reason"
  [ "$output" = '"non_zero_exit"' ]
  run _meta_value "pr-review-poll.agent.failed" "exitCode"
  [ "$output" = '1' ]
}

@test "run.completed preserves NO_FIXES_NEEDED terminal reason" {
  emit_event "pr-review-poll" "info" "pr-review-poll.poll.started" \
    "poll 1/3 for PR #456" prNumber=456 poll=1 maxPolls=3 totalPolls=1 maxTotalPolls=30
  emit_event "pr-review-poll" "info" "pr-review-poll.poll.comments.fetched" \
    "fetched 1 comments, 1 unprocessed" total=1 unprocessed=1
  emit_event "pr-review-poll" "info" "pr-review-poll.agent.started" \
    "invoking agent for poll iteration 1" commentId="batch-p1"
  emit_event "pr-review-poll" "info" "pr-review-poll.agent.completed" \
    "agent done for poll iteration 1: NO_FIXES_NEEDED" \
    commentId="batch-p1" result="NO_FIXES_NEEDED" durationMs=800
  emit_event "pr-review-poll" "info" "pr-review-poll.reply.posted" \
    "replies confirmed (no fixes needed)" commentId="batch-p1"
  emit_event "pr-review-poll" "info" "pr-review-poll.run.completed" \
    "PR review poll finished" totalProcessed=1 terminalReason="NO_FIXES_NEEDED"

  run _count_type "pr-review-poll.run.completed"
  [ "$output" = "1" ]

  local terminal_reason
  terminal_reason=$(jq -s '[.[] | select(.type == "pr-review-poll.run.completed")][0].metadata.terminalReason' "$AI_RUN_EVENTS_FILE")
  [ "$terminal_reason" = '"NO_FIXES_NEEDED"' ]
}

@test "agent.failed emitted when agent exits 0 but produces no valid result file" {
  emit_event "pr-review-poll" "info" "pr-review-poll.agent.started" \
    "invoking agent for poll iteration 1" commentId="batch-p1"
  emit_event "pr-review-poll" "error" "pr-review-poll.agent.failed" \
    "agent for poll iteration 1 produced no valid result file" \
    commentId="batch-p1" reason="no_result_file" exitCode=0 durationMs=3000

  run _count_type "pr-review-poll.agent.failed"
  [ "$output" = "1" ]
  run _count_type "pr-review-poll.agent.completed"
  [ "$output" = "0" ]

  run _meta_value "pr-review-poll.agent.failed" "reason"
  [ "$output" = '"no_result_file"' ]
}