#!/usr/bin/env bats

setup() {
  CHECK_SCRIPT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/check-bats-traps.sh"

  _TMPDIR="$(mktemp -d)"
  FIXTURE_DIR="$_TMPDIR/bats-test-dir"
  mkdir -p "$FIXTURE_DIR"

  export BATS_TEST_DIR="$FIXTURE_DIR"
}

teardown() {
  rm -rf "$_TMPDIR"
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

@test "fails when a .bats file contains trap unquoted function name EXIT" {
  cat > "$FIXTURE_DIR/bad_unquoted.bats" << 'BATS'
@test "bad test" {
  trap cleanup_fn EXIT
  true
}
BATS
  run_check
  [ "$status" -eq 1 ]
  [[ "$output" == *"::error::"* ]]
  [[ "$output" == *"bad_unquoted.bats"* ]]
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

@test "fails when trap body contains nested quotes (e.g. single-quoted with double-quoted variables)" {
  cat > "$FIXTURE_DIR/bad_nested.bats" << 'BATS'
@test "bad test" {
  trap 'rm -rf "$test_dir"' EXIT
  true
}
BATS
  run_check
  [ "$status" -eq 1 ]
  [[ "$output" == *"::error::"* ]]
  [[ "$output" == *"bad_nested.bats"* ]]
}

@test "scans multiple .bats files and reports all violations" {
  echo 'trap "x" EXIT' > "$FIXTURE_DIR/a.bats"
  echo 'trap "y" EXIT' > "$FIXTURE_DIR/b.bats"
  run_check
  [ "$status" -eq 1 ]
  [[ "$output" == *"a.bats"* ]]
  [[ "$output" == *"b.bats"* ]]
}

@test "fails when trap uses lowercase exit" {
  cat > "$FIXTURE_DIR/lowercase_exit.bats" << 'BATS'
@test "lowercase exit" {
  trap 'rm -rf $dir' exit
  true
}
BATS
  run_check
  [ "$status" -eq 1 ]
  [[ "$output" == *"lowercase_exit.bats"* ]]
}

@test "fails when trap uses mixed-case Exit" {
  cat > "$FIXTURE_DIR/mixed_case_exit.bats" << 'BATS'
@test "mixed case exit" {
  trap 'rm -rf $dir' Exit
  true
}
BATS
  run_check
  [ "$status" -eq 1 ]
  [[ "$output" == *"mixed_case_exit.bats"* ]]
}

@test "fails when trap uses numeric 0 (EXIT synonym)" {
  cat > "$FIXTURE_DIR/numeric_trap.bats" << 'BATS'
@test "numeric trap" {
  trap 'rm -rf $dir' 0
  true
}
BATS
  run_check
  [ "$status" -eq 1 ]
  [[ "$output" == *"numeric_trap.bats"* ]]
}
