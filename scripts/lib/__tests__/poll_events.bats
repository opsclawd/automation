#!/usr/bin/env bats
# Golden-trace tests for PR review poll event emission.
# Tests the event vocabulary and structure by sourcing emit_event.sh
# directly and calling it with the poll event types.

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
      "poll ${poll}/3 for PR #456" prNumber=456 poll=$poll maxPolls=3
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
      "verification passed for batch p${poll}" commentId="batch-p${poll}"
    if [[ $poll -lt 3 ]]; then
      emit_event "pr-review-poll" "info" "pr-review-poll.poll.completed" \
        "poll ${poll} complete" poll=$poll processed=$poll pending=$((3 - poll))
    fi
  done
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
  run _count_type "pr-review-poll.poll.completed"
  [ "$output" = "2" ]
}

@test "blocked trace emits run.failed with reason BLOCKED" {
  emit_event "pr-review-poll" "info" "pr-review-poll.poll.started" \
    "poll 1/3 for PR #456" prNumber=456 poll=1 maxPolls=3
  emit_event "pr-review-poll" "info" "pr-review-poll.poll.comments.fetched" \
    "fetched comments" total=1 unprocessed=1
  emit_event "pr-review-poll" "info" "pr-review-poll.agent.started" \
    "invoking agent for poll iteration 1" commentId="batch-p1"
  emit_event "pr-review-poll" "error" "pr-review-poll.agent.failed" \
    "agent blocked for poll iteration 1" \
    commentId="batch-p1" reason="BLOCKED" exitCode=0
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
      "poll ${poll}/3 for PR #456" prNumber=456 poll=$poll maxPolls=3
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

@test "events contain correct phase field" {
  emit_event "pr-review-poll" "info" "pr-review-poll.poll.started" "test" poll=1 maxPolls=3
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
