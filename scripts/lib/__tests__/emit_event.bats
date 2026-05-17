#!/usr/bin/env bats

setup() {
  TMPDIR_TEST="$(mktemp -d)"
  export AI_RUN_EVENTS_FILE="${TMPDIR_TEST}/events.jsonl"
  export AI_RUN_DISPLAY_ID="issue-1-20260516-120000"
  # shellcheck source=../emit_event.sh
  source "${BATS_TEST_DIRNAME}/../emit_event.sh"
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

@test "emit_event writes a single valid JSON line" {
  emit_event "plan-write" "info" "phase.started" "starting plan write"
  [ "$(wc -l < "$AI_RUN_EVENTS_FILE")" -eq 1 ]
  run jq -e '.runId == "issue-1-20260516-120000" and .phase == "plan-write" and .level == "info" and .type == "phase.started" and .message == "starting plan write" and (.metadata | length == 0)' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
}

@test "emit_event escapes quotes, backslashes, newlines in message" {
  emit_event "review" "error" "phase.failed" $'line1\n"quoted"\\backslash'
  run jq -r '.message' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
  [ "$output" = $'line1\n"quoted"\\backslash' ]
}

@test "emit_event accepts k=v metadata pairs with type inference" {
  emit_event "validate" "error" "phase.failed" "build failed" command="pnpm build" exitCode=2
  run jq -e '.metadata.command == "pnpm build" and (.metadata.exitCode | tonumber) == 2' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
}

@test "emit_event omits phase when called with empty phase" {
  emit_event "" "info" "run.started" "starting run"
  run jq -e 'has("phase") | not' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
}

@test "emit_event is a no-op when AI_RUN_EVENTS_FILE is unset" {
  unset AI_RUN_EVENTS_FILE
  run emit_event "plan-write" "info" "phase.started" "ignored"
  [ "$status" -eq 0 ]
}

@test "emit_event appends, never truncates" {
  emit_event "p" "info" "a" "first"
  emit_event "p" "info" "b" "second"
  [ "$(wc -l < "$AI_RUN_EVENTS_FILE")" -eq 2 ]
}

@test "concurrent writers do not interleave bytes within a line" {
  for i in 1 2 3 4 5 6 7 8 9 10; do
    emit_event "p" "info" "t" "msg-$i" idx=$i &
  done
  wait
  # Every line must be valid JSON
  while IFS= read -r line; do
    echo "$line" | jq -e '.message' >/dev/null
  done < "$AI_RUN_EVENTS_FILE"
  [ "$(wc -l < "$AI_RUN_EVENTS_FILE")" -eq 10 ]
}
