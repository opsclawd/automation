#!/usr/bin/env bats

setup() {
  source "${BATS_TEST_DIRNAME}/../validation_result.sh"
}

@test "validation_result_from_exit: 0 -> passed" {
  run validation_result_from_exit 0
  [ "$status" -eq 0 ]
  [ "$output" = "passed" ]
}

@test "validation_result_from_exit: 1 -> failed" {
  run validation_result_from_exit 1
  [ "$output" = "failed" ]
}

@test "validation_result_from_exit: 2 (config error) -> failed" {
  run validation_result_from_exit 2
  [ "$output" = "failed" ]
}

@test "validation_result_from_exit: 3 (unexpected) -> failed" {
  run validation_result_from_exit 3
  [ "$output" = "failed" ]
}

@test "validation_result_from_exit: missing arg defaults to failed" {
  run validation_result_from_exit
  [ "$output" = "failed" ]
}