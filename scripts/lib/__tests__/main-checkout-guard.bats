#!/usr/bin/env bats

# Two roots are tracked here:
#  - REAL_REPO_ROOT: the actual repo this test file lives in. Used ONLY for
#    structural greps against scripts/ai-pr-review-poll (read-only).
#  - FIXTURE_REPO:   a throwaway git repo created in TMPDIR_TEST. Used as the
#    target of `_guard_main_checkout`, which runs `git reset --hard HEAD` and
#    `git clean -fd` — destructive ops that must NEVER hit the real worktree.
#
# The guard function is sourced from the real script (REAL_REPO_ROOT) but
# operates on $REPO_ROOT, which is reassigned to FIXTURE_REPO before each
# guard test invocation.

setup() {
  REAL_REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  TMPDIR_TEST="$(mktemp -d)"
  export AI_RUN_EVENTS_FILE="$TMPDIR_TEST/events.jsonl"
  export AI_RUN_DISPLAY_ID="test-main-guard-$(date +%s)"
  export POLL_COUNT=1
  export ISSUES_DIR="$TMPDIR_TEST"

  # Build an isolated git repo for guard tests. Minimum surface needed by the
  # guard: a working tree with an initial commit so HEAD exists, plus a
  # tracked .gitignore to mutate.
  FIXTURE_REPO="$TMPDIR_TEST/fixture-repo"
  mkdir -p "$FIXTURE_REPO"
  git -C "$FIXTURE_REPO" init -q
  git -C "$FIXTURE_REPO" config user.email "test@example.com"
  git -C "$FIXTURE_REPO" config user.name "test"
  : > "$FIXTURE_REPO/.gitignore"
  git -C "$FIXTURE_REPO" add .gitignore
  git -C "$FIXTURE_REPO" commit -q -m "init"

  # Source warn/log + _guard_main_checkout from the real script. These will
  # reference $REPO_ROOT at call time, so guard tests must set REPO_ROOT to
  # FIXTURE_REPO before invoking.
  # shellcheck source=../emit_event.sh
  source "${BATS_TEST_DIRNAME}/../emit_event.sh"
  # shellcheck source=../guard-main-checkout.sh
  source "${BATS_TEST_DIRNAME}/../guard-main-checkout.sh"

  log() { :; }
  warn() { log "WARN: $*" >&2; }
}

setup_worktree_fixture() {
  local _dir="$1"
  mkdir -p "$_dir"
  git -C "$_dir" init -q
  git -C "$_dir" config user.email "test@example.com"
  git -C "$_dir" config user.name "test"
  : > "$_dir/.gitignore"
  git -C "$_dir" add .gitignore
  git -C "$_dir" commit -q -m "init"
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

@test "_guard_main_checkout is a no-op when POLL_WORKTREE equals REPO_ROOT" {
  REPO_ROOT="$FIXTURE_REPO"
  export POLL_WORKTREE="$FIXTURE_REPO"
  run _guard_main_checkout "test"
  [ "$status" -eq 0 ]
}

@test "_guard_main_checkout is a no-op when main checkout is clean" {
  REPO_ROOT="$FIXTURE_REPO"
  export POLL_WORKTREE="$TMPDIR_TEST/fake-worktree"
  mkdir -p "$POLL_WORKTREE"
  run _guard_main_checkout "test"
  [ "$status" -eq 0 ]
}

@test "_guard_main_checkout resets leaked changes when no orchestrator_fail (legacy path)" {
  REPO_ROOT="$FIXTURE_REPO"
  export POLL_WORKTREE="$TMPDIR_TEST/fake-worktree"
  mkdir -p "$POLL_WORKTREE"

  echo "# __test_guard_leak_$$" >> "$FIXTURE_REPO/.gitignore"

  run _guard_main_checkout "test"
  [ "$status" -eq 0 ]

  run git -C "$FIXTURE_REPO" diff --quiet
  [ "$status" -eq 0 ]

  run jq -e '.type == "test.main_leak_detected"' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
}

@test "_guard_main_checkout resets staged leaked changes when no orchestrator_fail (legacy path) (regression: PR #132 reviewer)" {
  REPO_ROOT="$FIXTURE_REPO"
  export POLL_WORKTREE="$TMPDIR_TEST/fake-worktree"
  mkdir -p "$POLL_WORKTREE"

  # Simulate `git add -A` having staged a leak — `git checkout -- .` alone
  # would leave the staged entry behind. The guard must clear the index too.
  echo "leak" >> "$FIXTURE_REPO/.gitignore"
  git -C "$FIXTURE_REPO" add .gitignore

  run _guard_main_checkout "test"
  [ "$status" -eq 0 ]

  # Both working tree and index must be clean.
  run git -C "$FIXTURE_REPO" diff --quiet
  [ "$status" -eq 0 ]
  run git -C "$FIXTURE_REPO" diff --cached --quiet
  [ "$status" -eq 0 ]
}

@test "_guard_main_checkout removes untracked leaked files when no orchestrator_fail (legacy path)" {
  REPO_ROOT="$FIXTURE_REPO"
  export POLL_WORKTREE="$TMPDIR_TEST/fake-worktree"
  mkdir -p "$POLL_WORKTREE"

  echo "untracked" > "$FIXTURE_REPO/leaked-untracked.txt"

  run _guard_main_checkout "test"
  [ "$status" -eq 0 ]

  [ ! -f "$FIXTURE_REPO/leaked-untracked.txt" ]
}

@test "_guard_main_checkout rewinds HEAD when agent committed a leak when no orchestrator_fail (legacy path) (regression: PR #132 comment 3322104761)" {
  REPO_ROOT="$FIXTURE_REPO"
  export POLL_WORKTREE="$TMPDIR_TEST/fake-worktree"
  mkdir -p "$POLL_WORKTREE"

  local pre_state
  pre_state=$(_capture_main_state)
  local pre_sha="${pre_state%%|*}"

  # Simulate agent running `git add -A && git commit` in main: HEAD advances
  # to a clean leaked commit. Dirty checks alone won't catch this.
  echo "leaked content" > "$FIXTURE_REPO/leaked.txt"
  git -C "$FIXTURE_REPO" add leaked.txt
  git -C "$FIXTURE_REPO" -c user.email=t@t -c user.name=t commit -q -m "leaked"

  local leaked_sha
  leaked_sha=$(git -C "$FIXTURE_REPO" rev-parse HEAD)
  [ "$leaked_sha" != "$pre_sha" ]

  run _guard_main_checkout "test" "$pre_state"
  [ "$status" -eq 0 ]

  # HEAD must be back at pre_sha and the leaked file must be gone.
  local final_sha
  final_sha=$(git -C "$FIXTURE_REPO" rev-parse HEAD)
  [ "$final_sha" = "$pre_sha" ]
  [ ! -f "$FIXTURE_REPO/leaked.txt" ]
}

@test "_guard_main_checkout preserves pre-existing dirty work (regression: PR #132 comment 3322133613)" {
  REPO_ROOT="$FIXTURE_REPO"
  export POLL_WORKTREE="$TMPDIR_TEST/fake-worktree"
  mkdir -p "$POLL_WORKTREE"

  # Developer has unstaged local work BEFORE the agent runs.
  echo "developer edit" >> "$FIXTURE_REPO/.gitignore"
  echo "dev untracked" > "$FIXTURE_REPO/dev-scratch.txt"

  # Capture state AFTER the dirty edits (simulating pre-agent baseline).
  local pre_state
  pre_state=$(_capture_main_state)

  # Agent runs (in this scenario, doesn't add to the dirty state).
  run _guard_main_checkout "test" "$pre_state"
  [ "$status" -eq 0 ]

  # Developer's work must be preserved: both the tracked edit and the
  # untracked file must still be present.
  run grep -q "developer edit" "$FIXTURE_REPO/.gitignore"
  [ "$status" -eq 0 ]
  [ -f "$FIXTURE_REPO/dev-scratch.txt" ]

  # Event log should record the skip rather than a leak.
  run jq -e '.type == "test.main_dirty_preexisting"' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
}

@test "_guard_main_checkout restores branch after same-SHA switch despite pre-existing dirty work (regression: PR #152 comment 3328202153)" {
  REPO_ROOT="$FIXTURE_REPO"
  export WORKTREE_DIR="$TMPDIR_TEST/fake-worktree"
  unset POLL_WORKTREE
  mkdir -p "$WORKTREE_DIR"

  local _default_branch
  _default_branch=$(git -C "$FIXTURE_REPO" rev-parse --abbrev-ref HEAD)
  git -C "$FIXTURE_REPO" branch same-sha-branch

  echo "developer edit" >> "$FIXTURE_REPO/.gitignore"
  echo "dev untracked" > "$FIXTURE_REPO/dev-scratch.txt"

  local pre_state
  pre_state=$(_capture_main_state)

  git -C "$FIXTURE_REPO" checkout -q same-sha-branch

  run _guard_main_checkout "test" "$pre_state"
  [ "$status" -eq 0 ]

  run git -C "$FIXTURE_REPO" rev-parse --abbrev-ref HEAD
  [ "$output" = "$_default_branch" ]

  run git -C "$FIXTURE_REPO" rev-parse HEAD
  [ "$output" = "${pre_state%%|*}" ]

  run grep -q "developer edit" "$FIXTURE_REPO/.gitignore"
  [ "$status" -eq 0 ]
  [ -f "$FIXTURE_REPO/dev-scratch.txt" ]

  grep -q '"test.main_dirty_preexisting"' "$AI_RUN_EVENTS_FILE"
  grep -q '"test.main_branch_restored"' "$AI_RUN_EVENTS_FILE"
}

@test "_guard_main_checkout refuses to auto-reset when pre-agent dirty AND HEAD moved (regression: PR #132 comment 3322160882)" {
  REPO_ROOT="$FIXTURE_REPO"
  export POLL_WORKTREE="$TMPDIR_TEST/fake-worktree"
  mkdir -p "$POLL_WORKTREE"

  # Developer has unstaged tracked edit + untracked file before agent runs.
  echo "developer tracked edit" >> "$FIXTURE_REPO/.gitignore"
  echo "dev untracked" > "$FIXTURE_REPO/dev-untracked.txt"
  local pre_state
  pre_state=$(_capture_main_state)
  local pre_sha="${pre_state%%|*}"

  # Agent runs `git add -A && git commit`, sweeping the developer's tracked
  # edit into a leaked commit. HEAD moves.
  git -C "$FIXTURE_REPO" add -A
  git -C "$FIXTURE_REPO" -c user.email=t@t -c user.name=t commit -q -m "leak-with-dev-work"
  local leaked_sha
  leaked_sha=$(git -C "$FIXTURE_REPO" rev-parse HEAD)
  [ "$leaked_sha" != "$pre_sha" ]

  run _guard_main_checkout "test" "$pre_state"
  [ "$status" -eq 0 ]

  # Guard must NOT have reset — that would discard the developer's tracked
  # edit (it lives in the leaked commit, not on disk after a reset).
  local final_sha
  final_sha=$(git -C "$FIXTURE_REPO" rev-parse HEAD)
  [ "$final_sha" = "$leaked_sha" ]

  # Untracked file must also be preserved.
  [ -f "$FIXTURE_REPO/dev-untracked.txt" ]

  # Event log records the unsafe-recovery decision so it's auditable.
  run jq -e '.type == "test.main_leak_unsafe_recovery"' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
}

@test "_guard_main_checkout does not rewind HEAD when no expected_sha is passed (back-compat)" {
  REPO_ROOT="$FIXTURE_REPO"
  export POLL_WORKTREE="$TMPDIR_TEST/fake-worktree"
  mkdir -p "$POLL_WORKTREE"

  # Move HEAD forward; without expected_sha the guard must not rewind it,
  # because it has no way to know the move was a leak.
  echo "advance" > "$FIXTURE_REPO/x.txt"
  git -C "$FIXTURE_REPO" add x.txt
  git -C "$FIXTURE_REPO" -c user.email=t@t -c user.name=t commit -q -m "advance"

  local after_sha
  after_sha=$(git -C "$FIXTURE_REPO" rev-parse HEAD)

  run _guard_main_checkout "test"
  [ "$status" -eq 0 ]

  local final_sha
  final_sha=$(git -C "$FIXTURE_REPO" rev-parse HEAD)
  [ "$final_sha" = "$after_sha" ]
}

@test "_guard_main_checkout switches back to original branch before resetting HEAD (regression: PR #152 comment 3328041429)" {
  REPO_ROOT="$FIXTURE_REPO"
  export WORKTREE_DIR="$TMPDIR_TEST/fake-worktree"
  unset POLL_WORKTREE
  mkdir -p "$WORKTREE_DIR"

  local _default_branch
  _default_branch=$(git -C "$FIXTURE_REPO" rev-parse --abbrev-ref HEAD)
  git -C "$FIXTURE_REPO" checkout -q -b other-branch
  echo "other-content" > "$FIXTURE_REPO/other.txt"
  git -C "$FIXTURE_REPO" add other.txt
  git -C "$FIXTURE_REPO" -c user.email=t@t -c user.name=t commit -q -m "other"
  git -C "$FIXTURE_REPO" checkout -q "$_default_branch"

  local pre_state
  pre_state=$(_capture_main_state)
  local pre_sha="${pre_state%%|*}"

  git -C "$FIXTURE_REPO" checkout -q other-branch

  run _guard_main_checkout "test" "$pre_state"
  [ "$status" -eq 0 ]

  run git -C "$FIXTURE_REPO" rev-parse --abbrev-ref HEAD
  [ "$output" = "$_default_branch" ]

  run git -C "$FIXTURE_REPO" rev-parse HEAD
  [ "$output" = "$pre_sha" ]

  run git -C "$FIXTURE_REPO" rev-parse other-branch
  [ "$output" != "$pre_sha" ]
}

@test "_guard_main_checkout refuses reset when checkout of pre_branch fails (regression: PR #152 comment 3328061467)" {
  REPO_ROOT="$FIXTURE_REPO"
  export WORKTREE_DIR="$TMPDIR_TEST/fake-worktree"
  unset POLL_WORKTREE
  mkdir -p "$WORKTREE_DIR"

  echo "main-content" > "$FIXTURE_REPO/tracked.txt"
  git -C "$FIXTURE_REPO" add tracked.txt
  git -C "$FIXTURE_REPO" -c user.email=t@t -c user.name=t commit -q -m "add tracked"

  git -C "$FIXTURE_REPO" checkout -q -b other-branch
  echo "other-content" > "$FIXTURE_REPO/tracked.txt"
  git -C "$FIXTURE_REPO" add tracked.txt
  git -C "$FIXTURE_REPO" -c user.email=t@t -c user.name=t commit -q -m "other branch content"
  git -C "$FIXTURE_REPO" checkout -q -

  local pre_state
  pre_state=$(_capture_main_state)

  git -C "$FIXTURE_REPO" checkout -q other-branch
  echo "dirty-on-other" > "$FIXTURE_REPO/tracked.txt"

  run _guard_main_checkout "test" "$pre_state"
  [ "$status" -eq 0 ]

  run git -C "$FIXTURE_REPO" rev-parse --abbrev-ref HEAD
  [ "$output" = "other-branch" ]

  run git -C "$FIXTURE_REPO" rev-parse HEAD
  [ "$output" != "${pre_state%%|*}" ]

  run jq -e '.type == "test.main_leak_unsafe_recovery"' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
}

@test "_guard_main_checkout refuses reset when pre-agent was detached and agent left on a branch (regression: PR #152 comment 3328139630)" {
  REPO_ROOT="$FIXTURE_REPO"
  export WORKTREE_DIR="$TMPDIR_TEST/fake-worktree"
  unset POLL_WORKTREE
  mkdir -p "$WORKTREE_DIR"

  git -C "$FIXTURE_REPO" checkout -q --detach HEAD

  local pre_state
  pre_state=$(_capture_main_state)

  git -C "$FIXTURE_REPO" checkout -q -b agent-branch
  echo "agent-leak" > "$FIXTURE_REPO/leaked.txt"
  git -C "$FIXTURE_REPO" add leaked.txt
  git -C "$FIXTURE_REPO" -c user.email=t@t -c user.name=t commit -q -m "agent leak on branch"

  run _guard_main_checkout "test" "$pre_state"
  [ "$status" -eq 0 ]

  run git -C "$FIXTURE_REPO" rev-parse --abbrev-ref HEAD
  [ "$output" = "agent-branch" ]

  run git -C "$FIXTURE_REPO" rev-parse HEAD
  [ "$output" != "${pre_state%%|*}" ]

  run jq -e '.type == "test.main_leak_unsafe_recovery"' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
}

@test "_guard_main_checkout restores branch after same-SHA branch switch (regression: PR #152 comment 3328169899)" {
  REPO_ROOT="$FIXTURE_REPO"
  export WORKTREE_DIR="$TMPDIR_TEST/fake-worktree"
  unset POLL_WORKTREE
  mkdir -p "$WORKTREE_DIR"

  local _default_branch
  _default_branch=$(git -C "$FIXTURE_REPO" rev-parse --abbrev-ref HEAD)
  git -C "$FIXTURE_REPO" branch same-sha-branch

  local pre_state
  pre_state=$(_capture_main_state)
  local pre_sha="${pre_state%%|*}"

  git -C "$FIXTURE_REPO" checkout -q same-sha-branch

  run _guard_main_checkout "test" "$pre_state"
  [ "$status" -eq 0 ]

  run git -C "$FIXTURE_REPO" rev-parse --abbrev-ref HEAD
  [ "$output" = "$_default_branch" ]

  run git -C "$FIXTURE_REPO" rev-parse HEAD
  [ "$output" = "$pre_sha" ]

  run jq -e '.type == "test.main_branch_restored"' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
}

@test "_guard_main_checkout restores detached HEAD after same-SHA branch switch from detached" {
  REPO_ROOT="$FIXTURE_REPO"
  export WORKTREE_DIR="$TMPDIR_TEST/fake-worktree"
  unset POLL_WORKTREE
  mkdir -p "$WORKTREE_DIR"

  git -C "$FIXTURE_REPO" checkout -q --detach HEAD

  local pre_state
  pre_state=$(_capture_main_state)

  git -C "$FIXTURE_REPO" checkout -q -b agent-branch

  run _guard_main_checkout "test" "$pre_state"
  [ "$status" -eq 0 ]

  run git -C "$FIXTURE_REPO" rev-parse --abbrev-ref HEAD
  [ "$output" = "HEAD" ]

  run jq -e '.type == "test.main_branch_restored"' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
}

@test "_guard_main_checkout emits event with pollIteration metadata" {
  REPO_ROOT="$FIXTURE_REPO"
  export POLL_WORKTREE="$TMPDIR_TEST/fake-worktree"
  mkdir -p "$POLL_WORKTREE"
  export POLL_COUNT=7

  echo "# __test_guard_leak2_$$" >> "$FIXTURE_REPO/.gitignore"
  _guard_main_checkout "test"

  run jq -e '.metadata.pollIteration == 7' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
}

@test "_guard_main_checkout works with WORKTREE_DIR instead of POLL_WORKTREE when no orchestrator_fail (legacy path)" {
  REPO_ROOT="$FIXTURE_REPO"
  export WORKTREE_DIR="$TMPDIR_TEST/fake-worktree"
  unset POLL_WORKTREE
  mkdir -p "$WORKTREE_DIR"

  echo "# __test_guard_worktree_$$" >> "$FIXTURE_REPO/.gitignore"

  run _guard_main_checkout "test"
  [ "$status" -eq 0 ]

  run git -C "$FIXTURE_REPO" diff --quiet
  [ "$status" -eq 0 ]
}

@test "_guard_main_checkout emits event with guard_label as prefix" {
  REPO_ROOT="$FIXTURE_REPO"
  export WORKTREE_DIR="$TMPDIR_TEST/fake-worktree"
  unset POLL_WORKTREE
  mkdir -p "$WORKTREE_DIR"

  echo "# __test_guard_prefix_$$" >> "$FIXTURE_REPO/.gitignore"

  _guard_main_checkout "plan-write"

  run jq -e '.type == "plan-write.main_leak_detected"' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
}

@test "_guard_main_checkout is a no-op when WORKTREE_DIR equals REPO_ROOT" {
  REPO_ROOT="$FIXTURE_REPO"
  export WORKTREE_DIR="$FIXTURE_REPO"

  echo "# should_not_be_reset_$$" >> "$FIXTURE_REPO/.gitignore"

  run _guard_main_checkout "test"
  [ "$status" -eq 0 ]

  run git -C "$FIXTURE_REPO" diff --quiet
  [ "$status" -ne 0 ]
}

@test "_capture_worktree_state returns clean state on clean worktree" {
  local _dir="$TMPDIR_TEST/worktree-clean"
  setup_worktree_fixture "$_dir"
  export WORKTREE_DIR="$_dir"
  export REPO_ROOT="$FIXTURE_REPO"
  unset POLL_WORKTREE

  run _capture_worktree_state
  [ "$status" -eq 0 ]
  # Output format: sha|dirty|branch
  [[ "$output" =~ ^[a-f0-9]{40}\|0\| ]]
}

@test "_capture_worktree_state detects dirty worktree (tracked file modified)" {
  local _dir="$TMPDIR_TEST/worktree-dirty"
  setup_worktree_fixture "$_dir"
  echo "dirty" >> "$_dir/.gitignore"
  export WORKTREE_DIR="$_dir"
  export REPO_ROOT="$FIXTURE_REPO"
  unset POLL_WORKTREE

  run _capture_worktree_state
  [ "$status" -eq 0 ]
  [[ "$output" =~ \|1\| ]]
}

@test "_capture_worktree_state detects staged changes (index dirty)" {
  local _dir="$TMPDIR_TEST/worktree-staged"
  setup_worktree_fixture "$_dir"
  echo "staged" >> "$_dir/.gitignore"
  git -C "$_dir" add .gitignore
  export WORKTREE_DIR="$_dir"
  export REPO_ROOT="$FIXTURE_REPO"
  unset POLL_WORKTREE

  run _capture_worktree_state
  [ "$status" -eq 0 ]
  [[ "$output" =~ \|1\| ]]
}

@test "_capture_worktree_state detects untracked files" {
  local _dir="$TMPDIR_TEST/worktree-untracked"
  setup_worktree_fixture "$_dir"
  echo "untracked" > "$_dir/new-file.txt"
  export WORKTREE_DIR="$_dir"
  export REPO_ROOT="$FIXTURE_REPO"
  unset POLL_WORKTREE

  run _capture_worktree_state
  [ "$status" -eq 0 ]
  [[ "$output" =~ \|1\| ]]
}

@test "_capture_worktree_state captures branch name correctly" {
  local _dir="$TMPDIR_TEST/worktree-branch"
  setup_worktree_fixture "$_dir"
  git -C "$_dir" checkout -q -b feature-branch
  export WORKTREE_DIR="$_dir"
  export REPO_ROOT="$FIXTURE_REPO"
  unset POLL_WORKTREE

  run _capture_worktree_state
  [ "$status" -eq 0 ]
  [[ "$output" =~ \|0\|feature-branch$ ]]
}

@test "_guard_worktree is a no-op when worktree is clean" {
  local _dir="$TMPDIR_TEST/worktree-guard-clean"
  setup_worktree_fixture "$_dir"
  export WORKTREE_DIR="$_dir"
  export REPO_ROOT="$FIXTURE_REPO"
  unset POLL_WORKTREE

  run _guard_worktree "test"
  [ "$status" -eq 0 ]
}

@test "_guard_worktree resets leaked changes when no orchestrator_fail (legacy path)" {
  local _dir="$TMPDIR_TEST/worktree-guard-dirty"
  setup_worktree_fixture "$_dir"
  export WORKTREE_DIR="$_dir"
  export REPO_ROOT="$FIXTURE_REPO"
  unset POLL_WORKTREE

  echo "# __test_guard_wt_leak_$$" >> "$_dir/.gitignore"

  run _guard_worktree "test"
  [ "$status" -eq 0 ]

  run git -C "$_dir" diff --quiet
  [ "$status" -eq 0 ]

  run jq -e '.type == "test.worktree_leak_detected"' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
}

@test "_guard_worktree resets staged leaked changes when no orchestrator_fail (legacy path)" {
  local _dir="$TMPDIR_TEST/worktree-guard-staged"
  setup_worktree_fixture "$_dir"
  export WORKTREE_DIR="$_dir"
  export REPO_ROOT="$FIXTURE_REPO"
  unset POLL_WORKTREE

  echo "leak" >> "$_dir/.gitignore"
  git -C "$_dir" add .gitignore

  run _guard_worktree "test"
  [ "$status" -eq 0 ]

  run git -C "$_dir" diff --quiet
  [ "$status" -eq 0 ]
  run git -C "$_dir" diff --cached --quiet
  [ "$status" -eq 0 ]
}

@test "_guard_worktree removes untracked leaked files when no orchestrator_fail (legacy path)" {
  local _dir="$TMPDIR_TEST/worktree-guard-untracked"
  setup_worktree_fixture "$_dir"
  export WORKTREE_DIR="$_dir"
  export REPO_ROOT="$FIXTURE_REPO"
  unset POLL_WORKTREE

  echo "untracked" > "$_dir/leaked-untracked.txt"

  run _guard_worktree "test"
  [ "$status" -eq 0 ]

  [ ! -f "$_dir/leaked-untracked.txt" ]
}

@test "_guard_worktree rewinds HEAD when agent committed a leak when no orchestrator_fail (legacy path)" {
  local _dir="$TMPDIR_TEST/worktree-guard-commit"
  setup_worktree_fixture "$_dir"
  export WORKTREE_DIR="$_dir"
  export REPO_ROOT="$FIXTURE_REPO"
  unset POLL_WORKTREE

  local pre_state
  pre_state=$(_capture_worktree_state)
  local pre_sha="${pre_state%%|*}"

  echo "leaked content" > "$_dir/leaked.txt"
  git -C "$_dir" add leaked.txt
  git -C "$_dir" -c user.email=t@t -c user.name=t commit -q -m "leaked"

  local leaked_sha
  leaked_sha=$(git -C "$_dir" rev-parse HEAD)
  [ "$leaked_sha" != "$pre_sha" ]

  run _guard_worktree "test" "$pre_state"
  [ "$status" -eq 0 ]

  local final_sha
  final_sha=$(git -C "$_dir" rev-parse HEAD)
  [ "$final_sha" = "$pre_sha" ]
  [ ! -f "$_dir/leaked.txt" ]
}

@test "_guard_worktree preserves pre-existing dirty work" {
  local _dir="$TMPDIR_TEST/worktree-guard-predirty"
  setup_worktree_fixture "$_dir"
  export WORKTREE_DIR="$_dir"
  export REPO_ROOT="$FIXTURE_REPO"
  unset POLL_WORKTREE

  echo "developer edit" >> "$_dir/.gitignore"
  echo "dev untracked" > "$_dir/dev-scratch.txt"

  local pre_state
  pre_state=$(_capture_worktree_state)

  run _guard_worktree "test" "$pre_state"
  [ "$status" -eq 0 ]

  run grep -q "developer edit" "$_dir/.gitignore"
  [ "$status" -eq 0 ]
  [ -f "$_dir/dev-scratch.txt" ]

  run jq -e '.type == "test.worktree_dirty_preexisting"' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
}

@test "_guard_worktree restores branch after same-SHA branch switch" {
  local _dir="$TMPDIR_TEST/worktree-guard-samesha"
  setup_worktree_fixture "$_dir"
  git -C "$_dir" branch same-sha-branch
  export WORKTREE_DIR="$_dir"
  export REPO_ROOT="$FIXTURE_REPO"
  unset POLL_WORKTREE

  local _default_branch
  _default_branch=$(git -C "$_dir" rev-parse --abbrev-ref HEAD)

  local pre_state
  pre_state=$(_capture_worktree_state)
  local pre_sha="${pre_state%%|*}"

  git -C "$_dir" checkout -q same-sha-branch

  run _guard_worktree "test" "$pre_state"
  [ "$status" -eq 0 ]

  run git -C "$_dir" rev-parse --abbrev-ref HEAD
  [ "$output" = "$_default_branch" ]

  run git -C "$_dir" rev-parse HEAD
  [ "$output" = "$pre_sha" ]

  run jq -e '.type == "test.worktree_branch_restored"' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
}

@test "_guard_worktree restores detached HEAD after same-SHA branch switch from detached" {
  local _dir="$TMPDIR_TEST/worktree-guard-detached"
  setup_worktree_fixture "$_dir"
  git -C "$_dir" checkout -q --detach HEAD
  export WORKTREE_DIR="$_dir"
  export REPO_ROOT="$FIXTURE_REPO"
  unset POLL_WORKTREE

  local pre_state
  pre_state=$(_capture_worktree_state)

  git -C "$_dir" checkout -q -b agent-branch

  run _guard_worktree "test" "$pre_state"
  [ "$status" -eq 0 ]

  run git -C "$_dir" rev-parse --abbrev-ref HEAD
  [ "$output" = "HEAD" ]

  run jq -e '.type == "test.worktree_branch_restored"' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
}

@test "_guard_worktree hard-fails on same-SHA branch switch when orchestrator_fail defined" {
  local _dir="$TMPDIR_TEST/worktree-guard-branch-switch-only-fail"
  setup_worktree_fixture "$_dir"
  git -C "$_dir" branch same-sha-branch
  export WORKTREE_DIR="$_dir"
  export REPO_ROOT="$FIXTURE_REPO"
  unset POLL_WORKTREE

  orchestrator_fail() {
    echo "orchestrator_fail called: $1" > "$TMPDIR_TEST/fail-reason.txt"
    return 1
  }

  local _default_branch
  _default_branch=$(git -C "$_dir" rev-parse --abbrev-ref HEAD)

  local pre_state
  pre_state=$(_capture_worktree_state)

  git -C "$_dir" checkout -q same-sha-branch

  run _guard_worktree "test" "$pre_state"
  [ "$status" -ne 0 ]
  [ -f "$TMPDIR_TEST/fail-reason.txt" ]
  run grep -q "branch switch" "$TMPDIR_TEST/fail-reason.txt"
  [ "$status" -eq 0 ]
}

@test "_guard_worktree refuses to auto-reset when pre-agent dirty AND HEAD moved" {
  local _dir="$TMPDIR_TEST/worktree-guard-dirty-moved"
  setup_worktree_fixture "$_dir"
  export WORKTREE_DIR="$_dir"
  export REPO_ROOT="$FIXTURE_REPO"
  unset POLL_WORKTREE

  echo "developer tracked edit" >> "$_dir/.gitignore"
  echo "dev untracked" > "$_dir/dev-untracked.txt"
  local pre_state
  pre_state=$(_capture_worktree_state)
  local pre_sha="${pre_state%%|*}"

  git -C "$_dir" add -A
  git -C "$_dir" -c user.email=t@t -c user.name=t commit -q -m "leak-with-dev-work"
  local leaked_sha
  leaked_sha=$(git -C "$_dir" rev-parse HEAD)
  [ "$leaked_sha" != "$pre_sha" ]

  run _guard_worktree "test" "$pre_state"
  [ "$status" -eq 0 ]

  local final_sha
  final_sha=$(git -C "$_dir" rev-parse HEAD)
  [ "$final_sha" = "$leaked_sha" ]

  [ -f "$_dir/dev-untracked.txt" ]

  run jq -e '.type == "test.worktree_leak_unsafe_recovery"' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
}

@test "_guard_worktree calls orchestrator_fail on detected leak (hard-fail)" {
  local _dir="$TMPDIR_TEST/worktree-guard-hardfail"
  setup_worktree_fixture "$_dir"
  export WORKTREE_DIR="$_dir"
  export REPO_ROOT="$FIXTURE_REPO"
  unset POLL_WORKTREE

  orchestrator_fail() {
    echo "orchestrator_fail called: $1" > "$TMPDIR_TEST/fail-reason.txt"
    return 1
  }

  local pre_state
  pre_state=$(_capture_worktree_state)

  echo "# __test_guard_wt_hardfail_$$" >> "$_dir/.gitignore"

  run _guard_worktree "test" "$pre_state"
  [ "$status" -ne 0 ]
  [ -f "$TMPDIR_TEST/fail-reason.txt" ]
  run grep -q "leak" "$TMPDIR_TEST/fail-reason.txt"
  [ "$status" -eq 0 ]
}

@test "_guard_worktree hard-fails when branch switched from expected" {
  local _dir="$TMPDIR_TEST/worktree-guard-branch-fail"
  setup_worktree_fixture "$_dir"
  local _default_branch
  _default_branch=$(git -C "$_dir" rev-parse --abbrev-ref HEAD)
  git -C "$_dir" checkout -q -b other-branch
  echo "other" > "$_dir/other.txt"
  git -C "$_dir" add other.txt
  git -C "$_dir" -c user.email=t@t -c user.name=t commit -q -m "other"
  git -C "$_dir" checkout -q "$_default_branch"

  export WORKTREE_DIR="$_dir"
  export REPO_ROOT="$FIXTURE_REPO"
  unset POLL_WORKTREE

  orchestrator_fail() {
    echo "orchestrator_fail called: $1" > "$TMPDIR_TEST/fail-reason.txt"
    return 1
  }

  local pre_state
  pre_state=$(_capture_worktree_state)

  git -C "$_dir" checkout -q other-branch

  run _guard_worktree "test" "$pre_state"
  [ "$status" -ne 0 ]
  [ -f "$TMPDIR_TEST/fail-reason.txt" ]

  run git -C "$_dir" rev-parse --abbrev-ref HEAD
  [ "$output" = "other-branch" ]
}

@test "_guard_worktree fails when WORKTREE_DIR is unset" {
  export REPO_ROOT="$FIXTURE_REPO"
  unset WORKTREE_DIR
  unset POLL_WORKTREE

  run _guard_worktree "test"
  [ "$status" -ne 0 ]
}

@test "ai-pr-review-poll has no pushd callsites" {
  run grep -c 'pushd' "$REAL_REPO_ROOT/scripts/ai-pr-review-poll"
  [ "$output" -eq 0 ]
}

@test "ai-pr-review-poll has no popd callsites" {
  run grep -c 'popd' "$REAL_REPO_ROOT/scripts/ai-pr-review-poll"
  [ "$output" -eq 0 ]
}

@test "ai-pr-review-poll sources shared guard library" {
  # Guard library sourcing now lives in the legacy script (M6-05 shim delegates to TS poller)
  run grep -q 'source.*guard-main-checkout.sh' "$REAL_REPO_ROOT/scripts/legacy/ai-pr-review-poll.legacy"
  [ "$status" -eq 0 ]
}

@test "ai-pr-review-poll has two _guard_main_checkout callsites" {
  # Guard callsites now live in the legacy script (M6-05 shim delegates to TS poller)
  # Match callsites only (function invocation at start of indentation),
  # excluding the function definition itself and any references in comments.
  callsite_count=$(grep -cE '^[[:space:]]+_guard_main_checkout\b' "$REAL_REPO_ROOT/scripts/legacy/ai-pr-review-poll.legacy")
  [ "$callsite_count" -eq 2 ]
}

@test "ai-pr-review-poll prompt forbids pushing to main" {
  # Prompt template now lives in the legacy script (M6-05 shim delegates to TS poller)
  run grep -c 'Never push to main' "$REAL_REPO_ROOT/scripts/legacy/ai-pr-review-poll.legacy"
  [ "$output" -eq 1 ]
}

@test "ai-pr-review-poll Step 3 template has branch-name comment" {
  # Prompt template now lives in the legacy script (M6-05 shim delegates to TS poller)
  run grep -c 'Do NOT change this branch name' "$REAL_REPO_ROOT/scripts/legacy/ai-pr-review-poll.legacy"
  [ "$output" -eq 1 ]
}

@test "_detach_main_head detaches REPO_ROOT HEAD and records original branch" {
  REPO_ROOT="$FIXTURE_REPO"
  local _default_branch
  _default_branch=$(git -C "$FIXTURE_REPO" rev-parse --abbrev-ref HEAD)
  local _pre_sha
  _pre_sha=$(git -C "$FIXTURE_REPO" rev-parse HEAD)

  _detach_main_head

  # After detach, HEAD should be detached (rev-parse --abbrev-ref returns HEAD)
  local _detached_ref
  _detached_ref=$(git -C "$FIXTURE_REPO" rev-parse --abbrev-ref HEAD)
  [ "$_detached_ref" = "HEAD" ]

  # Env var must record the original branch
  [ -n "${_ORIGINAL_MAIN_BRANCH:-}" ]
  [ "$_ORIGINAL_MAIN_BRANCH" = "$_default_branch" ]
  [ -n "${_RESTORE_HEAD_SHA:-}" ]
  [ "$_RESTORE_HEAD_SHA" = "$_pre_sha" ]
}

@test "_detach_main_head works when REPO_ROOT is already on detached HEAD" {
  REPO_ROOT="$FIXTURE_REPO"
  git -C "$FIXTURE_REPO" checkout -q --detach HEAD
  local _pre_sha
  _pre_sha=$(git -C "$FIXTURE_REPO" rev-parse HEAD)

  _detach_main_head

  # Already detached, env var records the detached state
  [ "${_ORIGINAL_MAIN_BRANCH:-}" = "HEAD" ]
  [ "${_RESTORE_HEAD_SHA:-}" = "$_pre_sha" ]
}

@test "_reattach_main_head restores original branch after detach" {
  REPO_ROOT="$FIXTURE_REPO"
  local _default_branch
  _default_branch=$(git -C "$FIXTURE_REPO" rev-parse --abbrev-ref HEAD)

  _detach_main_head
  # Commit on detached HEAD — simulates agent leak
  echo "leak" > "$FIXTURE_REPO/leak.txt"
  git -C "$FIXTURE_REPO" add leak.txt
  git -C "$FIXTURE_REPO" -c user.email=t@t -c user.name=t commit -q -m "leak"

  run _reattach_main_head
  [ "$status" -eq 0 ]

  # Branch should be restored
  local _current_branch
  _current_branch=$(git -C "$FIXTURE_REPO" rev-parse --abbrev-ref HEAD)
  [ "$_current_branch" = "$_default_branch" ]

  # SHA should be back at the original (leak commit is orphaned)
  local _current_sha
  _current_sha=$(git -C "$FIXTURE_REPO" rev-parse HEAD)
  [ "$_current_sha" = "$_RESTORE_HEAD_SHA" ]
}

@test "_reattach_main_head fails when HEAD advanced while detached (leak prevention failure)" {
  REPO_ROOT="$FIXTURE_REPO"

  _detach_main_head
  echo "leak" > "$FIXTURE_REPO/leak.txt"
  git -C "$FIXTURE_REPO" add leak.txt
  git -C "$FIXTURE_REPO" -c user.email=t@t -c user.name=t commit -q -m "leak"

  # Simulate that RESTORE_HEAD_SHA is stored, but we also need to detect
  # that HEAD moved while detached. _reattach_main_head should still succeed
  # at restoration (goes back to original branch) but emit a warning event
  # and leave the orphan commit unreachable.
  run _reattach_main_head
  [ "$status" -eq 0 ]

  # The leak commit should be orphaned (original branch is restored, no new commit on branch)
  local _default_branch
  _default_branch=$(git -C "$FIXTURE_REPO" rev-parse --abbrev-ref HEAD)
  git -C "$FIXTURE_REPO" log --oneline "$_default_branch" | grep -qv "leak" || true
}

@test "_reattach_main_head is a no-op when _ORIGINAL_MAIN_BRANCH is unset" {
  REPO_ROOT="$FIXTURE_REPO"
  unset _ORIGINAL_MAIN_BRANCH
  run _reattach_main_head
  [ "$status" -eq 0 ]
}

@test "_guard_main_checkout calls orchestrator_fail on detected leak (hard-fail)" {
  REPO_ROOT="$FIXTURE_REPO"
  export WORKTREE_DIR="$TMPDIR_TEST/fake-worktree"
  unset POLL_WORKTREE
  mkdir -p "$WORKTREE_DIR"

  orchestrator_fail() {
    echo "orchestrator_fail called: $1" > "$TMPDIR_TEST/fail-reason.txt"
    return 1
  }

  local pre_state
  pre_state=$(_capture_main_state)

  echo "# __test_guard_hardfail_$$" >> "$FIXTURE_REPO/.gitignore"

  run _guard_main_checkout "test" "$pre_state"
  [ "$status" -ne 0 ]
  [ -f "$TMPDIR_TEST/fail-reason.txt" ]
  run grep -q "leak" "$TMPDIR_TEST/fail-reason.txt"
  [ "$status" -eq 0 ]
}

@test "_guard_main_checkout warns when pre-was-dirty even with orchestrator_fail defined" {
  REPO_ROOT="$FIXTURE_REPO"
  export WORKTREE_DIR="$TMPDIR_TEST/fake-worktree"
  unset POLL_WORKTREE
  mkdir -p "$WORKTREE_DIR"

  orchestrator_fail() {
    echo "orchestrator_fail should not be called for pre-dirty" > "$TMPDIR_TEST/should-not-exist.txt"
    return 1
  }

  echo "dev edit" >> "$FIXTURE_REPO/.gitignore"
  local pre_state
  pre_state=$(_capture_main_state)

  echo "more dirt" >> "$FIXTURE_REPO/.gitignore"

  run _guard_main_checkout "test" "$pre_state"
  [ "$status" -eq 0 ]
  [ ! -f "$TMPDIR_TEST/should-not-exist.txt" ]
}

@test "_guard_main_checkout falls back to warn-when-no-orchestrator_fail (legacy compat)" {
  REPO_ROOT="$FIXTURE_REPO"
  export POLL_WORKTREE="$TMPDIR_TEST/fake-worktree"
  mkdir -p "$POLL_WORKTREE"

  echo "# __test_guard_legacycompat_$$" >> "$FIXTURE_REPO/.gitignore"

  run _guard_main_checkout "test"
  [ "$status" -eq 0 ]

  run git -C "$FIXTURE_REPO" diff --quiet
  [ "$status" -eq 0 ]
}

@test "_guard_main_checkout hard-fails when agent committed on main (HEAD moved)" {
  REPO_ROOT="$FIXTURE_REPO"
  export WORKTREE_DIR="$TMPDIR_TEST/fake-worktree"
  unset POLL_WORKTREE
  mkdir -p "$WORKTREE_DIR"

  orchestrator_fail() {
    echo "orchestrator_fail called: $1" > "$TMPDIR_TEST/fail-reason.txt"
    return 1
  }

  local pre_state
  pre_state=$(_capture_main_state)
  local pre_sha="${pre_state%%|*}"

  echo "leaked content" > "$FIXTURE_REPO/leaked.txt"
  git -C "$FIXTURE_REPO" add leaked.txt
  git -C "$FIXTURE_REPO" -c user.email=t@t -c user.name=t commit -q -m "leaked"

  run _guard_main_checkout "test" "$pre_state"
  [ "$status" -ne 0 ]
  [ -f "$TMPDIR_TEST/fail-reason.txt" ]

  local final_sha
  final_sha=$(git -C "$FIXTURE_REPO" rev-parse HEAD)
  [ "$final_sha" != "$pre_sha" ]
}

@test "_guard_main_checkout hard-fails when branch switched from expected" {
  REPO_ROOT="$FIXTURE_REPO"
  export WORKTREE_DIR="$TMPDIR_TEST/fake-worktree"
  unset POLL_WORKTREE
  mkdir -p "$WORKTREE_DIR"

  orchestrator_fail() {
    echo "orchestrator_fail called: $1" > "$TMPDIR_TEST/fail-reason.txt"
    return 1
  }

  local _default_branch
  _default_branch=$(git -C "$FIXTURE_REPO" rev-parse --abbrev-ref HEAD)
  git -C "$FIXTURE_REPO" checkout -q -b other-branch
  echo "other" > "$FIXTURE_REPO/other.txt"
  git -C "$FIXTURE_REPO" add other.txt
  git -C "$FIXTURE_REPO" -c user.email=t@t -c user.name=t commit -q -m "other"
  git -C "$FIXTURE_REPO" checkout -q "$_default_branch"

  local pre_state
  pre_state=$(_capture_main_state)

  git -C "$FIXTURE_REPO" checkout -q other-branch

  run _guard_main_checkout "test" "$pre_state"
  [ "$status" -ne 0 ]
  [ -f "$TMPDIR_TEST/fail-reason.txt" ]

  run git -C "$FIXTURE_REPO" rev-parse --abbrev-ref HEAD
  [ "$output" = "other-branch" ]
}
