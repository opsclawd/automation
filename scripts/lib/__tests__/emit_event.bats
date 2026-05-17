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

@test "metadata keys with hyphens and dots produce valid JSON" {
  emit_event "p" "info" "phase.started" "test hyphenated key" my-key="val1" phase.type="started"
  [ "$(wc -l < "$AI_RUN_EVENTS_FILE")" -eq 1 ]
  run jq -e '.metadata["my-key"] == "val1" and .metadata["phase.type"] == "started"' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
}

@test "metadata keys with special characters produce valid JSON" {
  emit_event "p" "info" "phase.started" "test special key" 'a"b'="val1" 'c\d'="val2"
  [ "$(wc -l < "$AI_RUN_EVENTS_FILE")" -eq 1 ]
  run jq -e '.metadata["a\"b"] == "val1" and .metadata["c\\d"] == "val2"' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
}

@test "distinct metadata keys that sanitize identically preserve separate values" {
  emit_event "p" "info" "phase.started" "collision test" my-key="alpha" my_key="beta"
  [ "$(wc -l < "$AI_RUN_EVENTS_FILE")" -eq 1 ]
  run jq -e '.metadata["my-key"] == "alpha" and .metadata.my_key == "beta"' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
}

@test "metadata value containing equals sign" {
  emit_event "p" "info" "t" "test equals in value" cmd="git commit -m \"fix\""
  run jq -e '.metadata.cmd == "git commit -m \"fix\""' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
}

@test "pure-Bash fallback path produces valid JSON when jq is unavailable" {
  local fake_path
  fake_path="$(mktemp -d)"
  touch "$fake_path/jq"
  chmod -x "$fake_path/jq"
  local orig_path="$PATH"
  PATH="$fake_path:$PATH"
  export PATH

  emit_event "p" "info" "phase.started" "fallback test" command="hello"

  PATH="$orig_path"
  export PATH
  rm -rf "$fake_path"

  local line_count
  line_count=$(wc -l < "$AI_RUN_EVENTS_FILE")
  [ "$line_count" -eq 1 ]

  run jq -e '.runId == "issue-1-20260516-120000" and .level == "info" and .type == "phase.started"' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
}

@test "AI_RUN_DISPLAY_ID unset produces warning and no-op" {
  unset AI_RUN_DISPLAY_ID
  run emit_event "p" "info" "t" "should be skipped"
  [ "$status" -eq 0 ]
  [[ "$output" == *"emit_event: AI_RUN_DISPLAY_ID is unset"* ]]
}

@test "emit_event works under set -euo pipefail" {
  (
    set -euo pipefail
    # shellcheck source=../emit_event.sh
    source "${BATS_TEST_DIRNAME}/../emit_event.sh"
    emit_event "p" "info" "t" "strict mode test"
  )
  [ "$(wc -l < "$AI_RUN_EVENTS_FILE")" -eq 1 ]
  run jq -e '.message == "strict mode test"' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]

  (
    set -euo pipefail
    # shellcheck source=../emit_event.sh
    source "${BATS_TEST_DIRNAME}/../emit_event.sh"
    unset AI_RUN_EVENTS_FILE
    emit_event "p" "info" "t" "no-op under strict"
  )
}
