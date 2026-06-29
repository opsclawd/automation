#!/usr/bin/env bats

# Regression test: worktree exclude rules must be seeded on every orchestrator
# invocation, including resumed runs where the worktree already exists.
# See: scripts/legacy/ai-run-issue-v2 — seed_excludes() / ensure_worktree()
setup() {
  TMPDIR_TEST="$(mktemp -d)"
  REPO_ROOT="$TMPDIR_TEST/repo"
  WORKTREE_DIR="$TMPDIR_TEST/worktree"
  mkdir -p "$REPO_ROOT"
  cd "$REPO_ROOT"
  # Init a bare-minimum git repo
  git init -q
  git config user.email "test@test.com"
  git config user.name "Test"
  echo "init" > README.md
  git add README.md
  git commit -q -m "init"
  # Create a worktree on a branch
  git worktree add "$WORKTREE_DIR" -b test-branch HEAD
  export REPO_ROOT WORKTREE_DIR
}
teardown() {
  rm -rf "$TMPDIR_TEST"
}
@test "seed_excludes writes exclude file with key orchestrator patterns" {
  # Source the helper from the script (it is defined as a shell function).
  # We extract just the seed_excludes function to test in isolation.
  local script_path
  script_path="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/legacy/ai-run-issue-v2"
  # Extract seed_excludes function and source it
  eval "$(sed -n '/^seed_excludes()/,/^}/p' "$script_path")"
  seed_excludes
  local common_dir
  common_dir=$(cd "$WORKTREE_DIR" && git rev-parse --git-common-dir)
  local exclude_file="${common_dir}/info/exclude"
  [ -f "$exclude_file" ]
  # Verify key patterns are present
  grep -q 'design\.md' "$exclude_file"
  grep -q 'plan\.md' "$exclude_file"
  grep -q 'compound\.md' "$exclude_file"
  grep -q '\*\.log' "$exclude_file"
  grep -q '\*\.result' "$exclude_file"
  grep -q 'node_modules/' "$exclude_file"
}
@test "seed_excludes is idempotent — calling twice does not duplicate patterns" {
  local script_path
  script_path="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/legacy/ai-run-issue-v2"
  eval "$(sed -n '/^seed_excludes()/,/^}/p' "$script_path")"
  seed_excludes
  seed_excludes
  local common_dir
  common_dir=$(cd "$WORKTREE_DIR" && git rev-parse --git-common-dir)
  local exclude_file="${common_dir}/info/exclude"
  [ -f "$exclude_file" ]
  # Sentinel guard short-circuits the second call, so each pattern appears once.
  local count
  count=$(grep -c 'design\.md' "$exclude_file")
  [ "$count" -eq 1 ]
}
@test "orchestrator artifacts are excluded from git after seed_excludes" {
  local script_path
  script_path="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/legacy/ai-run-issue-v2"
  eval "$(sed -n '/^seed_excludes()/,/^}/p' "$script_path")"
  seed_excludes
  cd "$WORKTREE_DIR"
  # Create orchestrator artifacts
  echo "# design" > design.md
  echo "# plan" > plan.md
  echo "log data" > orchestrator.log
  echo "result" > implement-task-1.result
  # None should appear in git status
  run git status --porcelain
  [ "$status" -eq 0 ]
  # Output should be empty (no tracked/untracked changes)
  [ -z "$output" ]
}
@test "git add -A and commit do not include excluded artifacts" {
  local script_path
  script_path="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/legacy/ai-run-issue-v2"
  eval "$(sed -n '/^seed_excludes()/,/^}/p' "$script_path")"
  seed_excludes
  cd "$WORKTREE_DIR"
  # Create a real file plus orchestrator artifacts
  echo "real code" > feature.ts
  echo "# design doc" > design.md
  echo "# plan doc" > plan.md
  echo "log output" > implement-task-1.log
  git add -A
  git commit -q -m "add feature"
  # Only feature.ts should be in the commit
  run git diff --name-only HEAD~1..HEAD
  [ "$status" -eq 0 ]
  [ "$output" = "feature.ts" ]
}
@test "simulate resume: existing worktree with design.md does not commit it" {
  # Simulates the bug: worktree exists from a prior run, design.md is already
  # present. After calling seed_excludes (as ensure_worktree now does),
  # design.md must NOT be tracked.
  local script_path
  script_path="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/legacy/ai-run-issue-v2"
  # First, create design.md BEFORE calling seed_excludes (simulates resume)
  cd "$WORKTREE_DIR"
  echo "# existing design from prior run" > design.md
  echo "# existing plan from prior run" > plan.md
  # Now call seed_excludes (as ensure_worktree would on resume)
  eval "$(sed -n '/^seed_excludes()/,/^}/p' "$script_path")"
  seed_excludes
  # Add a real change and commit
  echo "real code" > feature.ts
  git add -A
  git commit -q -m "implement feature"
  # design.md and plan.md must NOT be in the commit
  run git diff --name-only HEAD~1..HEAD
  [ "$status" -eq 0 ]
  [ "$output" = "feature.ts" ]
}

@test "simulate resume: old sentinel re-seeds with task-manifest.json pattern" {
  # Simulates a resumed run where the exclude file has the old sentinel
  # (arbiter-result.json) but not the new pattern (task-manifest.json).
  # seed_excludes must re-seed so task-manifest.json is excluded.
  local script_path
  script_path="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/legacy/ai-run-issue-v2"
  cd "$WORKTREE_DIR"
  local common_dir
  common_dir=$(git rev-parse --git-common-dir)
  local exclude_file="${common_dir}/info/exclude"
  mkdir -p "${common_dir}/info"
  # Write old sentinel-only exclude file (pre-task-manifest era)
  cat >> "$exclude_file" << 'OLDBLOCK'
*.log
*.result
design.md
plan.md
arbiter-result.json
OLDBLOCK
  # Verify old sentinel is present but task-manifest.json is absent
  grep -qxF 'arbiter-result.json' "$exclude_file"
  ! grep -qxF 'task-manifest.json' "$exclude_file"
  # Call seed_excludes (simulates a resumed run)
  eval "$(sed -n '/^seed_excludes()/,/^}/p' "$script_path")"
  seed_excludes
  # task-manifest.json must now be in the exclude file
  grep -qxF 'task-manifest.json' "$exclude_file"
}

@test "fix-validate artifacts are excluded from git after seed_excludes" {
  local script_path
  script_path="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/legacy/ai-run-issue-v2"
  eval "$(sed -n '/^seed_excludes()/,/^}/p' "$script_path")"
  seed_excludes
  cd "$WORKTREE_DIR"
  echo "done" > fix-validate-done.marker
  echo "log" > fix-validate-1.log
  echo "log" > revalidate-fv-1.log
  echo "log" > fix-validate-log.md
  run git status --porcelain
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}
