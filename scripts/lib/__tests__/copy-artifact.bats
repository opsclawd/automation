#!/usr/bin/env bats

# Regression test for the review-triage "cp: are the same file" crash.
# ISSUES_DIR == WORKTREE_DIR in the issue-to-PR orchestrator, so persisting an
# artifact the agent already wrote is a self-copy; a plain `cp X X` errors and
# aborts the run. _copy_if_distinct must tolerate that.
# See: scripts/ai-run-issue-v2 — review-triage phase; scripts/lib/copy-artifact.sh

setup() {
  TMPDIR_TEST="$(mktemp -d)"
  source "$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/lib/copy-artifact.sh"
}
teardown() {
  rm -rf "$TMPDIR_TEST"
}

@test "_copy_if_distinct: same file (ISSUES_DIR == WORKTREE_DIR) succeeds without error" {
  echo '[{"id":"R1"}]' > "$TMPDIR_TEST/review-task-manifest.json"
  run _copy_if_distinct "$TMPDIR_TEST/review-task-manifest.json" "$TMPDIR_TEST/review-task-manifest.json"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  # File is left intact
  [ "$(cat "$TMPDIR_TEST/review-task-manifest.json")" = '[{"id":"R1"}]' ]
}

@test "_copy_if_distinct: same file via different path spelling (./) still treated as same" {
  mkdir -p "$TMPDIR_TEST/wt"
  echo 'data' > "$TMPDIR_TEST/wt/review-triage.md"
  run _copy_if_distinct "$TMPDIR_TEST/wt/review-triage.md" "$TMPDIR_TEST/wt/./review-triage.md"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  [ "$(cat "$TMPDIR_TEST/wt/review-triage.md")" = 'data' ]
}

@test "_copy_if_distinct: distinct paths actually copies content" {
  mkdir -p "$TMPDIR_TEST/src" "$TMPDIR_TEST/dest"
  echo 'manifest-body' > "$TMPDIR_TEST/src/m.json"
  run _copy_if_distinct "$TMPDIR_TEST/src/m.json" "$TMPDIR_TEST/dest/m.json"
  [ "$status" -eq 0 ]
  [ -f "$TMPDIR_TEST/dest/m.json" ]
  [ "$(cat "$TMPDIR_TEST/dest/m.json")" = 'manifest-body' ]
}

@test "_copy_if_distinct: distinct paths overwrites stale destination" {
  mkdir -p "$TMPDIR_TEST/src" "$TMPDIR_TEST/dest"
  echo 'new' > "$TMPDIR_TEST/src/m.json"
  echo 'old' > "$TMPDIR_TEST/dest/m.json"
  run _copy_if_distinct "$TMPDIR_TEST/src/m.json" "$TMPDIR_TEST/dest/m.json"
  [ "$status" -eq 0 ]
  [ "$(cat "$TMPDIR_TEST/dest/m.json")" = 'new' ]
}
