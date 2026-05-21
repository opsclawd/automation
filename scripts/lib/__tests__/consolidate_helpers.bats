#!/usr/bin/env bats

setup() {
  TMPDIR_TEST="$(mktemp -d)"
  cd "$TMPDIR_TEST"
  git init -q
  git config user.email "t@t"
  git config user.name "t"
  mkdir -p ai/issues/1 ai/issues/2 ai/poll-pr-100 ai/poll-pr-101 docs/solutions/orchestrator
  echo "issue 1 compound" > ai/issues/1/compound.md
  echo "issue 2 compound" > ai/issues/2/compound.md
  echo "poll 100 compound" > ai/poll-pr-100/compound-2026-05-20T10-00-00Z.md
  echo "poll 100 compound 2" > ai/poll-pr-100/compound-2026-05-20T11-00-00Z.md
  echo "poll 101 compound" > ai/poll-pr-101/compound-2026-05-20T12-00-00Z.md
  export REPO_ROOT="$TMPDIR_TEST"
  # shellcheck source=../consolidate_helpers.sh
  source "${BATS_TEST_DIRNAME}/../consolidate_helpers.sh"
}

teardown() { rm -rf "$TMPDIR_TEST"; }

@test "discover_inputs: returns all compound files when no docs/solutions commits exist" {
  run discover_inputs
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "ai/issues/1/compound.md"
  echo "$output" | grep -q "ai/issues/2/compound.md"
  echo "$output" | grep -q "ai/poll-pr-100/compound-2026-05-20T10-00-00Z.md"
  echo "$output" | grep -q "ai/poll-pr-101/compound-2026-05-20T12-00-00Z.md"
  [ "$(echo "$output" | wc -l | tr -d ' ')" -eq 5 ]
}

@test "discover_inputs: with --since <ref> returns only files newer than the ref" {
  # commit the first two compound files as if they were already consolidated
  git add ai/issues/1/compound.md ai/poll-pr-100/compound-2026-05-20T10-00-00Z.md
  git commit -q -m "snapshot before consolidation"
  local snap_sha
  snap_sha=$(git rev-parse HEAD)
  # add a new file after the ref
  mkdir -p ai/issues/3
  echo "issue 3 compound" > ai/issues/3/compound.md
  run discover_inputs --since "$snap_sha"
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "ai/issues/3/compound.md"
  ! echo "$output" | grep -q "ai/issues/1/compound.md"
}

@test "discover_inputs: with --issues 1,2 returns only those issues' compound files" {
  run discover_inputs --issues 1,2
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "ai/issues/1/compound.md"
  echo "$output" | grep -q "ai/issues/2/compound.md"
  ! echo "$output" | grep -q "ai/poll-pr-"
}
