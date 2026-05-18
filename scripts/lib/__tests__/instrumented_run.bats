#!/usr/bin/env bats
# Smoke test: source the helper, exercise the same instrumentation pattern
# used in ai-run-issue-v2, and assert the produced events.jsonl has the
# expected types in the expected order.

setup() {
  TMPDIR_TEST=$(mktemp -d)
  export AI_RUN_EVENTS_FILE="$TMPDIR_TEST/events.jsonl"
  export AI_RUN_DISPLAY_ID="issue-7-20260516-120000"
  # shellcheck source=../emit_event.sh
  source "${BATS_TEST_DIRNAME}/../emit_event.sh"
}

teardown() { rm -rf "$TMPDIR_TEST"; }

@test "happy-path trace contains expected event types in order" {
  emit_event "" "info" "run.started" "starting" issueNumber=7
  for p in read_issue plan-design plan-write implement validate review fix-review compound create-pr; do
    emit_event "$p" "info" "phase.started" "starting $p"
    emit_event "$p" "info" "phase.completed" "done $p" durationMs=1
  done
  emit_event "" "info" "run.completed" "done"

  run jq -r '.type' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
  expected="run.started
phase.started
phase.completed
phase.started
phase.completed
phase.started
phase.completed
phase.started
phase.completed
phase.started
phase.completed
phase.started
phase.completed
phase.started
phase.completed
phase.started
phase.completed
phase.started
phase.completed
run.completed"
  [ "$output" = "$expected" ]
}

@test "failed trace emits phase.failed and run.failed with metadata" {
  emit_event "validate" "error" "phase.failed" "build failed" \
    command="pnpm build" exitCode=2 reason="build failed"
  emit_event "" "error" "run.failed" "build failed" \
    lastPhase="validate" reason="build failed"

  # Read the two events into an array
  run jq -s '.' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]

  # First event: phase.failed with exitCode and command
  run jq -r '.[0].metadata.exitCode' <(jq -s '.' "$AI_RUN_EVENTS_FILE")
  [ "$output" = "2" ]

  run jq -r '.[0].type' <(jq -s '.' "$AI_RUN_EVENTS_FILE")
  [ "$output" = "phase.failed" ]

  # Second event: run.failed with lastPhase
  run jq -r '.[1].metadata.lastPhase' <(jq -s '.' "$AI_RUN_EVENTS_FILE")
  [ "$output" = "validate" ]

  run jq -r '.[1].type' <(jq -s '.' "$AI_RUN_EVENTS_FILE")
  [ "$output" = "run.failed" ]
}

@test "phase.skipped events have correct type and reason" {
  for p in read_issue plan-design plan-write; do
    emit_event "$p" "warn" "phase.skipped" "phase ${p} skipped" reason="resume-detected"
  done

  run jq -r '.[0].type' <(jq -s '.' "$AI_RUN_EVENTS_FILE")
  [ "$output" = "phase.skipped" ]

  run jq -r '.[0].metadata.reason' <(jq -s '.' "$AI_RUN_EVENTS_FILE")
  [ "$output" = "resume-detected" ]

  run jq -r '.[2].phase' <(jq -s '.' "$AI_RUN_EVENTS_FILE")
  [ "$output" = "plan-write" ]
}

@test "loop.iteration.started has task, iteration, max" {
  emit_event "fix-review" "info" "loop.iteration.started" "loop 1/5 for task 2" \
    task=2 iteration=1 max=5

  run jq -e '.metadata.task == 2 and .metadata.iteration == 1 and .metadata.max == 5' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
}

@test "artifact.created has path and kind" {
  emit_event "validate" "info" "artifact.created" "validation written" \
    path="/tmp/x/validation.md" kind="validation"

  run jq -e '.metadata.kind == "validation" and .metadata.path == "/tmp/x/validation.md"' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
}