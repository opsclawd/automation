#!/usr/bin/env bats

setup() {
  CHECK_SCRIPT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/check-bats-traps.sh"

  TMPDIR="$(mktemp -d)"
  FIXTURE_DIR="$TMPDIR/bats-test-dir"
  mkdir -p "$FIXTURE_DIR"

  export BATS_TEST_DIR="$FIXTURE_DIR"
}

teardown() {
  rm -rf "$TMPDIR"
}

run_check() {
  run bash "$CHECK_SCRIPT"
}

@test "passes when no .bats files contain trap EXIT" {
  echo "@test \"clean test\" { true; }" > "$FIXTURE_DIR/clean.bats"
  run_check
  [ "$status" -eq 0 ]
}

@test "fails when a .bats file contains trap double-quoted EXIT" {
  cat > "$FIXTURE_DIR/bad.bats" << 'BATS'
@test "bad test" {
  trap "rm -rf \$dir" EXIT
  true
}
BATS
  run_check
  [ "$status" -eq 1 ]
  [[ "$output" == *"::error::"* ]]
  [[ "$output" == *"bad.bats"* ]]
}

@test "fails when a .bats file contains trap single-quoted EXIT" {
  cat > "$FIXTURE_DIR/bad2.bats" << "BATS"
@test "bad test" {
  trap 'rm -rf $dir' EXIT
  true
}
BATS
  run_check
  [ "$status" -eq 1 ]
  [[ "$output" == *"::error::"* ]]
  [[ "$output" == *"bad2.bats"* ]]
}

@test "error message references fix patterns" {
  cat > "$FIXTURE_DIR/bad3.bats" << 'BATS'
@test "bad test" {
  trap "cleanup" EXIT
  true
}
BATS
  run_check
  [ "$status" -eq 1 ]
  [[ "$output" == *"teardown()"* ]]
  [[ "$output" == *"rm -rf"* ]]
}

@test "skips non-.bats files in the scan directory" {
  echo 'trap "x" EXIT' > "$FIXTURE_DIR/not-bats.sh"
  run_check
  [ "$status" -eq 0 ]
}

@test "scans multiple .bats files and reports all violations" {
  echo 'trap "x" EXIT' > "$FIXTURE_DIR/a.bats"
  echo 'trap "y" EXIT' > "$FIXTURE_DIR/b.bats"
  run_check
  [ "$status" -eq 1 ]
  [[ "$output" == *"a.bats"* ]]
  [[ "$output" == *"b.bats"* ]]
}
