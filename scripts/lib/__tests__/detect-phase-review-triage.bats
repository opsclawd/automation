#!/usr/bin/env bats

setup() {
  TMPDIR_TEST="$(mktemp -d)"
  REPO_ROOT="$TMPDIR_TEST"
  WORKTREE_DIR="$TMPDIR_TEST"
  ISSUES_DIR="$TMPDIR_TEST"
  detect_resume_point() { echo "implement"; }
  source "$(cd "$BATS_TEST_DIRNAME/.." && pwd)/detect-phase.sh"
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

@test "detect_phase: review.md without manifest goes to review-triage" {
  echo "some review content" > "${ISSUES_DIR}/review.md"
  run detect_phase
  [ "$output" = "review-triage" ]
}

@test "detect_phase: review.md with manifest goes to fix-review" {
  echo "some review content" > "${ISSUES_DIR}/review.md"
  echo '[]' > "${ISSUES_DIR}/review-task-manifest.json"
  run detect_phase
  [ "$output" = "fix-review" ]
}
