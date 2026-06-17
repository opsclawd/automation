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

@test "detect_phase: review.md with manifest goes to review-fix" {
  echo "some review content" > "${ISSUES_DIR}/review.md"
  echo '[]' > "${ISSUES_DIR}/review-task-manifest.json"
  run detect_phase
  [ "$output" = "fix-review" ]
}

@test "detect_phase: validation passed without review.md goes to review-fix" {
  touch "${ISSUES_DIR}/validation.result"
  echo "passed" > "${ISSUES_DIR}/validation.result"
  echo "abc123" > "${ISSUES_DIR}/validation.headsha"
  git() { echo "abc123"; }
  export -f git
  run detect_phase
  [ "$output" = "review-fix" ]
}
