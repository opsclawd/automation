#!/usr/bin/env bats

setup() {
  SCRIPT_PATH="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/ai-run-issue-v2"
  eval "$(awk '
    /^_record_deviation\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
  ' "$SCRIPT_PATH")"
  LOG_OUTPUT=""
  log() { LOG_OUTPUT="${LOG_OUTPUT}$*\n"; }
  warn() { log "WARN: $*"; }
  EMIT_EVENT_ARGS=""
  emit_event() { EMIT_EVENT_ARGS="$*"; }
  TMPDIR_TEST="$(mktemp -d)"
  WORKTREE_DIR="$TMPDIR_TEST"
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

@test "deviation: creates deviation-record.md with required fields" {
  _record_deviation "1" "verification_spec_defect" "RESOLVED_TIEBREAK" "file:line evidence" "rationale text"
  [ -f "$TMPDIR_TEST/deviation-record.md" ]
  grep -q "verification_spec_defect" "$TMPDIR_TEST/deviation-record.md"
  grep -q "RESOLVED_TIEBREAK" "$TMPDIR_TEST/deviation-record.md"
  grep -q "file:line evidence" "$TMPDIR_TEST/deviation-record.md"
}

@test "deviation: creates deviation-record.json for machine consumption" {
  _record_deviation "2" "implementation_defect" "BLOCKED_IMPL_DEFECT" "some evidence" "some rationale"
  [ -f "$TMPDIR_TEST/deviation-record.json" ]
  run jq -r '.task' "$TMPDIR_TEST/deviation-record.json"
  [ "$output" = "2" ]
  run jq -r '.defect_classification' "$TMPDIR_TEST/deviation-record.json"
  [ "$output" = "implementation_defect" ]
  run jq -r '.outcome' "$TMPDIR_TEST/deviation-record.json"
  [ "$output" = "BLOCKED_IMPL_DEFECT" ]
}

@test "deviation: emits arbiter.deviation_recorded event" {
  _record_deviation "1" "verification_spec_defect" "DEVIATION_PROCEED" "ev" "rat"
  [[ "$EMIT_EVENT_ARGS" == *"deviation_recorded"* ]]
}

@test "deviation: includes issue number when ISSUE_NUM is set" {
  ISSUE_NUM=165
  _record_deviation "1" "verification_spec_defect" "DEVIATION_PROCEED" "ev" "rat"
  grep -q "165" "$TMPDIR_TEST/deviation-record.md"
}
