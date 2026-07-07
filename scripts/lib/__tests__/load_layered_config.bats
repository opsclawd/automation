#!/usr/bin/env bats

setup() {
  if [ -f "$BATS_TEST_DIRNAME/../test_helper.bash" ]; then
    load "../test_helper"
  fi

  TMPDIR_TEST="$(mktemp -d)"
  # Stub mktemp to create a predictable file in the test temp dir.
  mktemp() { echo "${TMPDIR_TEST}/.merged-config.json"; }

  # Resolve the four-input jq block from ai-run-issue-v2 into a function,
  # mirroring the extraction in phase_iteration_config.bats.
  setup_load_config_block
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

# Helpers

setup_load_config_block() {
  _load_config_block() {
    local SCRIPT_PATH
    SCRIPT_PATH="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/legacy/ai-run-issue-v2"
    eval "$(awk '
      /^_ORCHESTRATOR_CONFIG=/ { found=1 }
      found {
        print
        if (/^fi$/) { found=0 }
      }
    ' "$SCRIPT_PATH")"
  }
}

setup_repo_root() {
  local filename="$1"
  local content="$2"
  local repo_dir="${TMPDIR_TEST}/repo"
  mkdir -p "$repo_dir"
  echo "$content" > "${repo_dir}/${filename}"
  REPO_ROOT="$repo_dir"
}

setup_repo_root_with_local() {
  local filename1="$1"
  local content1="$2"
  local filename2="$3"
  local content2="$4"
  local repo_dir="${TMPDIR_TEST}/repo"
  mkdir -p "$repo_dir"
  echo "$content1" > "${repo_dir}/${filename1}"
  echo "$content2" > "${repo_dir}/${filename2}"
  REPO_ROOT="$repo_dir"
}

setup_target_root() {
  local filename="$1"
  local content="$2"
  local target_dir="${TMPDIR_TEST}/target"
  mkdir -p "$target_dir"
  echo "$content" > "${target_dir}/${filename}"
  echo "$target_dir"
}

setup_target_root_with_local() {
  local filename1="$1"
  local content1="$2"
  local filename2="$3"
  local content2="$4"
  local target_dir="${TMPDIR_TEST}/target"
  mkdir -p "$target_dir"
  echo "$content1" > "${target_dir}/${filename1}"
  echo "$content2" > "${target_dir}/${filename2}"
  echo "$target_dir"
}

load_layered_config() {
  local repo_root="$1"
  REPO_ROOT="$repo_root"
  REPO_TARGET=""
  _load_config_block
  echo "$_ACTIVE_CONFIG" > "${TMPDIR_TEST}/last_active_config"
}

load_layered_config_with_target() {
  local repo_root="$1"
  local repo_target="$2"
  REPO_ROOT="$repo_root"
  REPO_TARGET="$repo_target"
  _load_config_block
  echo "$_ACTIVE_CONFIG" > "${TMPDIR_TEST}/last_active_config"
}

_update_active_config() {
  if [ -f "${TMPDIR_TEST}/last_active_config" ]; then
    _ACTIVE_CONFIG="$(cat "${TMPDIR_TEST}/last_active_config")"
  fi
}

# Assertions

assert_success() {
  _update_active_config
  if [ "$status" -ne 0 ]; then
    echo "Expected status 0, but got $status"
    echo "Output: $output"
    return 1
  fi
}

assert_failure() {
  _update_active_config
  local expected_status="${1:-}"
  if [ "$status" -eq 0 ]; then
    echo "Expected non-zero exit status, but got 0"
    return 1
  fi
  if [ -n "$expected_status" ] && [ "$status" -ne "$expected_status" ]; then
    echo "Expected status $expected_status, but got $status"
    echo "Output: $output"
    return 1
  fi
}

assert_equal() {
  if [ "$1" != "$2" ]; then
    echo "Expected: '$2'"
    echo "Actual:   '$1'"
    return 1
  fi
}

assert_output() {
  local arg="$1"
  local val="$2"
  if [ "$arg" = "--partial" ]; then
    if [[ "$output" != *"$val"* ]]; then
      echo "Expected output to contain: '$val'"
      echo "Actual output: '$output'"
      return 1
    fi
  else
    if [ "$output" != "$arg" ]; then
      echo "Expected output: '$arg'"
      echo "Actual output:   '$output'"
      return 1
    fi
  fi
}

@test "layer 1 only: target paths resolve to /dev/null and merge yields base commands" {
  setup_repo_root ".ai-orchestrator.json" '{"validation":{"commands":["pnpm build"]}}'

  run load_layered_config "$REPO_ROOT"

  assert_success
  assert_equal "$(jq -r '.validation.commands | length' "$_ACTIVE_CONFIG")" "1"
}

@test "layer 2 present: automation local extends commands" {
  setup_repo_root_with_local \
    '.ai-orchestrator.json'      '{"validation":{"commands":["a"]}}' \
    '.ai-orchestrator.local.json' '{"validation":{"commands":["b"]}}'

  run load_layered_config "$REPO_ROOT"

  assert_success
  assert_equal "$(jq -r '.validation.commands | length' "$_ACTIVE_CONFIG")" "2"
}

@test "layer 3 present: target base wins for scalar key (jq *) " {
  setup_repo_root '.ai-orchestrator.json' '{"validation":{"commands":["a"]}}'
  REPO_TARGET="$(setup_target_root '.ai-orchestrator.json' '{"validation":{"commands":["t"]}}')"

  run load_layered_config_with_target "$REPO_ROOT" "$REPO_TARGET"

  assert_success
  assert_equal "$(jq -r '.validation.commands | length' "$_ACTIVE_CONFIG")" "2"
}

@test "layer 4 present: target local appended after target base" {
  setup_repo_root '.ai-orchestrator.json' '{"validation":{"commands":["a"]}}'
  REPO_TARGET="$(setup_target_root_with_local \
    '.ai-orchestrator.json'       '{"validation":{"commands":["t1"]}}' \
    '.ai-orchestrator.local.json' '{"validation":{"commands":["t2"]}}')"

  run load_layered_config_with_target "$REPO_ROOT" "$REPO_TARGET"

  assert_success
  assert_equal "$(jq -r '.validation.commands | length' "$_ACTIVE_CONFIG")" "3"
}

@test "absent target: target layers fall back to /dev/null and merge yields layers 1+2 only" {
  setup_repo_root_with_local \
    '.ai-orchestrator.json'       '{"validation":{"commands":["a"]}}' \
    '.ai-orchestrator.local.json' '{"validation":{"commands":["b"]}}'

  run load_layered_config "$REPO_ROOT"

  assert_success
  assert_equal "$(jq -r '.validation.commands | length' "$_ACTIVE_CONFIG")" "2"
}

@test "malformed target base: wrapper exits 2 and names target path" {
  setup_repo_root '.ai-orchestrator.json' '{"validation":{"commands":["a"]}}'
  REPO_TARGET="$(setup_target_root '.ai-orchestrator.json' '{not json')"

  run load_layered_config_with_target "$REPO_ROOT" "$REPO_TARGET"

  assert_failure 2
  assert_output --partial "target"
}
