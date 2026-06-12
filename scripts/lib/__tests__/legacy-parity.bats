#!/usr/bin/env bats

# Legacy-behaviour parity suite (#210) — SEED.
#
# Characterization tests for operationally critical invariants learned from real
# failures that currently live only as hardening in scripts/ai-run-issue-v2 and
# friends. They run against the live bash runner today. Before any phase's bash
# path is retired during the TypeScript cutover (M8-11), the TS implementation
# of that phase MUST satisfy the same contract — parity is "TS passes the same
# tests bash passes," enforced continuously in CI, not audited in a batch.
#
# Each test documents: the invariant, its source, the failure it prevents, and
# the TS-port contract. Prefer runtime-agnostic assertions (git/filesystem
# state, pure decisions) so the same contract can be driven against either
# runtime once a shared interface exists.
#
# This file is a seed (2 invariants). The full inventory to convert lives in
# the parity matrix on #210.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

# Invariant: per-run orchestrator artifacts are NEVER tracked by git.
# Source: #279 (hotfix) / #280 (durable guard).
# Failure prevented: a tracked artifact (e.g. validation.headsha) is rewritten
#   every run, dirties the worktree, and trips read-only phase mutation guards
#   -> run fails. Broke every review-triage on main when committed via #273.
# TS-port contract: the TS orchestrator must never stage/commit these paths.
#   Runtime-agnostic — pure git index state.
@test "parity[#279/#280]: per-run orchestrator artifacts are never tracked" {
  local artifacts=(
    validation.headsha
    review-fix-plan.json
    review-task-manifest.json
    review-triage.md
    code-review.md
  )
  for f in "${artifacts[@]}"; do
    run git -C "$REPO_ROOT" ls-files --error-unmatch -- "$f"
    [ "$status" -ne 0 ] || { echo "artifact is tracked (must be ignored): $f"; false; }
  done
}

# Invariant: a review-task manifest whose findings are ALL deferred/skipped has
#   zero actionable fix tasks, and fix-review treats that as nothing-to-fix
#   (success), never a crash or a bogus empty task iteration.
# Source: #282.
# Failure prevented: a clean PR with only minor (deferred) nits crashed
#   fix-review with exit 2.
# TS-port contract: the TS fix-review must classify an all-deferred manifest as
#   "no actionable tasks -> ALL_FIXED". The selection below (action == "fix",
#   or absent) is the contract the port must reproduce.
@test "parity[#282]: an all-deferred manifest yields zero actionable fix tasks" {
  local all_deferred='[{"action":"defer"},{"action":"skip"},{"action":"defer"}]'
  local mixed='[{"action":"fix"},{"action":"defer"}]'
  local empty='[]'
  [ "$(jq '[.[] | select(.action=="fix" or .action==null)] | length' <<< "$all_deferred")" -eq 0 ]
  [ "$(jq '[.[] | select(.action=="fix" or .action==null)] | length' <<< "$mixed")" -eq 1 ]
  [ "$(jq '[.[] | select(.action=="fix" or .action==null)] | length' <<< "$empty")" -eq 0 ]
}

# Invariant: revalidation after a fix never DISCARDS uncommitted agent work —
#   the per-task loop stashes and conditionally commits instead of `reset --hard`.
# Source: #281 (was #271). Deeper coverage: fix-review-stash.bats.
# Failure prevented: revalidate `reset --hard` deleted an uncommitted fix the
#   agent had produced but not yet committed.
# TS-port contract: whatever performs post-agent cleanup in TS must preserve
#   uncommitted work (stash/commit), never blind-reset.
@test "parity[#281]: fix-review preserves uncommitted work (stash-and-commit, not reset --hard)" {
  run grep -c '_stash_and_conditionally_commit' "$REPO_ROOT/scripts/ai-run-issue-v2"
  [ "$status" -eq 0 ]
  [ "$output" -ge 2 ]
}

# Invariant: fix-review escapes review-task IDs safely when pulling the finding
#   text into the agent prompt (no malformed inline sed).
# Source: #283 (was #272). Deeper coverage: fix-review-task-loop.bats (_escape_for_grep).
# Failure prevented: the malformed sed expression aborted, so retries ran blind
#   to the comment they were fixing.
# TS-port contract: fix-review must reliably carry the finding's text into the
#   prompt for the comment being fixed (the bash regex itself does not port).
@test "parity[#283]: fix-review uses safe task-id escaping, not the malformed sed" {
  run grep -c '_escape_for_grep' "$REPO_ROOT/scripts/ai-run-issue-v2"
  [ "$status" -eq 0 ]
  [ "$output" -ge 1 ]
  # The malformed expression that crashed must not return.
  run grep -F 's/[][.*^$/\\]/\\&/g' "$REPO_ROOT/scripts/ai-run-issue-v2"
  [ "$status" -ne 0 ]
}

# Invariant: agent prompt strings never let the orchestrator expand embedded
#   shell — literal snippets are escaped.
# Source: #287 (encoding of #284). Deeper coverage: implementer-prompt.bats; the
#   durable TS form is tracked in #288.
# Failure prevented: an unescaped PRE_HEAD reference in IMPLEMENTER_PROMPT was
#   expanded under set -u -> "PRE_HEAD: unbound variable" -> implement crashed.
# TS-port contract: prompt construction must be smoke-tested so an undefined
#   interpolation can never crash the orchestrator (see #288).
@test "parity[#287]: agent prompts do not let the orchestrator expand PRE_HEAD" {
  run grep -nF '"$PRE_HEAD"' "$REPO_ROOT/scripts/ai-run-issue-v2"
  [ "$status" -ne 0 ]
}

# Invariant: when revalidate is RED after a fix-review task, the commits that
#   task produced are reverted — a red revalidate can never ship as a "passed"
#   run carrying the bad commits. When revalidate is GREEN, commits are kept.
# Source: #274 (run reported passed + shipped a PR even though fix-review tasks
#   failed and revalidate was red). Helper: scripts/lib/fix-review-revert.sh.
#   Deeper coverage: fix-review-revert.bats.
# Failure prevented: fix-review applied a task commit, revalidate went red, and
#   the run still labelled itself passed and opened a PR with the broken commit.
# TS-port contract: the TS fix-review loop must, on a red revalidate, undo the
#   task's commits before deciding outcome (revert/audit-commit, not leave them
#   on the branch). Runtime-agnostic — driven by the real _revalidate_is_green
#   decision + git HEAD state.
@test "parity[#274]: fix-review reverts task commits when revalidate is red" {
  source "$REPO_ROOT/scripts/lib/fix-review-revert.sh"
  warn() { :; }
  emit_event() { :; }
  # Mirror the real _revalidate_is_green (ai-run-issue-v2): red iff the log
  # contains a "[<stage> failed]" marker.
  _revalidate_is_green() {
    local file=$1
    [[ -f "$file" ]] || return 1
    ! grep -qE '\[(build|lint|typecheck|test|test:bash) failed\]' "$file"
  }

  local repo="$BATS_TEST_TMPDIR/wt"
  mkdir -p "$repo"
  git -C "$repo" init -q
  git -C "$repo" config user.email "t@e.com"
  git -C "$repo" config user.name "t"
  echo base > "$repo/app.ts"
  git -C "$repo" add app.ts
  git -C "$repo" commit -q -m init

  local pre_head
  pre_head=$(git -C "$repo" rev-parse HEAD)
  echo "broken-by-fix" > "$repo/app.ts"
  git -C "$repo" add app.ts
  git -C "$repo" commit -q -m "fix-review task C1"

  # Red revalidate -> the task's change must be reverted out of the tree.
  local red_log="$BATS_TEST_TMPDIR/revalidate-red.log"
  printf '=== pnpm test ===\n[test failed]\n' > "$red_log"
  _revert_task_commits "$repo" "C1" "$pre_head" "$red_log"
  run cat "$repo/app.ts"
  [ "$output" = "base" ] || { echo "expected revert to restore base content, got: $output"; false; }

  # Green revalidate on a fresh task commit -> commit is preserved.
  local pre_head2
  pre_head2=$(git -C "$repo" rev-parse HEAD)
  echo "good-fix" > "$repo/app.ts"
  git -C "$repo" add app.ts
  git -C "$repo" commit -q -m "fix-review task C2"
  local green_log="$BATS_TEST_TMPDIR/revalidate-green.log"
  printf '=== pnpm test ===\n' > "$green_log"
  _revert_task_commits "$repo" "C2" "$pre_head2" "$green_log"
  run cat "$repo/app.ts"
  [ "$output" = "good-fix" ] || { echo "expected green revalidate to preserve fix, got: $output"; false; }
}

# Invariant: _detach_main_head detaches REPO_ROOT HEAD and records the
#   original branch in _ORIGINAL_MAIN_BRANCH so _reattach_main_head can
#   restore it at run end. The detach/reattach pair guarantees no agent
#   commit can advance main (commits on detached HEAD become orphaned).
# Source: #295.
# Failure prevented: agent commits leaked onto local main, diverging from
#   origin (e.g. fix/CI commit 6645816 in #290).
# TS-port contract: the TS orchestrator must detach REPO_ROOT HEAD before
#   agent invocations and restore afterward. Any commit made while detached
#   must be unreachable after restoration. Runtime-agnostic — pure git
#   plumbing (rev-parse HEAD, rev-parse --abbrev-ref, checkout --detach).
@test "parity[#295]: detached HEAD prevents commits from advancing main branch" {
  local repo="$BATS_TEST_TMPDIR/detach-repo"
  mkdir -p "$repo"
  git -C "$repo" init -q
  git -C "$repo" config user.email "t@t"
  git -C "$repo" config user.name "t"
  echo base > "$repo/app.ts"
  git -C "$repo" add app.ts
  git -C "$repo" commit -q -m init

  local _default_branch
  _default_branch=$(git -C "$repo" rev-parse --abbrev-ref HEAD)
  local _pre_sha
  _pre_sha=$(git -C "$repo" rev-parse HEAD)

  # Detach HEAD (mirrors _detach_main_head)
  git -C "$repo" checkout -q --detach HEAD

  # Simulate agent leak: commit on detached HEAD
  echo "leaked" > "$repo/leak.txt"
  git -C "$repo" add leak.txt
  git -C "$repo" -c user.email=t@t -c user.name=t commit -q -m "leak on detached"
  local _leaked_sha
  _leaked_sha=$(git -C "$repo" rev-parse HEAD)
  [ "$_leaked_sha" != "$_pre_sha" ]

  # Restore branch (mirrors _reattach_main_head)
  git -C "$repo" checkout -q "$_default_branch"

  # Branch must be back at the pre-run SHA — main was never advanced
  local _final_sha
  _final_sha=$(git -C "$repo" rev-parse HEAD)
  [ "$_final_sha" = "$_pre_sha" ]

  # The leaked commit is orphaned (unreachable from any branch)
  if ! git -C "$repo" merge-base --is-ancestor "$_leaked_sha" "$_default_branch" 2>/dev/null; then
    : # expected — leaked commit is not an ancestor of main
  else
    echo "FATAL: leaked commit is reachable from main branch — detach failed to prevent leak"
    false
  fi
}

# Invariant: _guard_main_checkout aborts the run (via orchestrator_fail) when
#   REPO_ROOT is mutated by an agent, rather than silently auto-resetting.
#   Auto-reset is only used as a legacy fallback when orchestrator_fail is
#   not defined (e.g. ai-pr-review-poll.legacy).
# Source: #295.
# Failure prevented: agent leaks silently auto-cleaned, masking the underlying
#   bug and allowing the run to continue in a corrupted state (e.g. commit
#   6645816 in #290).
# TS-port contract: the TS orchestrator guard must hard-fail on any detected
#   REPO_ROOT mutation (branch switch, HEAD advance, dirty tree) and must
#   never silently auto-reset.
@test "parity[#295]: guard hard-fails on REPO_ROOT mutation when orchestrator_fail is defined" {
  source "$REPO_ROOT/scripts/lib/guard-main-checkout.sh"
  source "$REPO_ROOT/scripts/lib/emit_event.sh"
  warn() { :; }

  local repo="$BATS_TEST_TMPDIR/gf"
  mkdir -p "$repo"
  git -C "$repo" init -q
  git -C "$repo" config user.email "t@t"
  git -C "$repo" config user.name "t"
  echo base > "$repo/app.ts"
  git -C "$repo" add app.ts
  git -C "$repo" commit -q -m init

  export REPO_ROOT="$repo"
  export WORKTREE_DIR="$BATS_TEST_TMPDIR/wt"
  mkdir -p "$WORKTREE_DIR"
  export AI_RUN_EVENTS_FILE="$BATS_TEST_TMPDIR/events.jsonl"
  : > "$AI_RUN_EVENTS_FILE"

  local _fail_called=false
  local _fail_reason=""
  orchestrator_fail() { _fail_called=true; _fail_reason="$1"; return 1; }

  local pre_state
  pre_state=$(_capture_main_state)

  echo "# leaked by agent" >> "$repo/.gitignore"

  _guard_main_checkout "test" "$pre_state" || true

  [ "$_fail_called" = "true" ]
  [[ "$_fail_reason" == *"Main checkout guard"* ]]

  if grep -q "leaked by agent" "$repo/.gitignore" 2>/dev/null; then
    : # expected — untracked file still present, guard did not auto-reset
  else
    echo "FATAL: guard auto-reset the leak despite orchestrator_fail being defined"
    false
  fi
}

# Invariant: when pre-state was dirty, the guard does NOT abort even
#   with orchestrator_fail defined — the dirty state predates the agent
#   and is intentional developer work that must be preserved.
# Source: #295 (extending #132 regression guardrail).
@test "parity[#295]: guard skips hard-fail when pre-agent state was already dirty" {
  source "$REPO_ROOT/scripts/lib/guard-main-checkout.sh"
  source "$REPO_ROOT/scripts/lib/emit_event.sh"
  warn() { :; }

  local repo="$BATS_TEST_TMPDIR/gf2"
  mkdir -p "$repo"
  git -C "$repo" init -q
  git -C "$repo" config user.email "t@t"
  git -C "$repo" config user.name "t"
  echo base > "$repo/app.ts"
  git -C "$repo" add app.ts
  git -C "$repo" commit -q -m init

  export REPO_ROOT="$repo"
  export WORKTREE_DIR="$BATS_TEST_TMPDIR/wt2"
  mkdir -p "$WORKTREE_DIR"
  export AI_RUN_EVENTS_FILE="$BATS_TEST_TMPDIR/events2.jsonl"
  : > "$AI_RUN_EVENTS_FILE"

  local _fail_called=false
  orchestrator_fail() { _fail_called=true; return 1; }

  echo "dev edit" >> "$repo/app.ts"

  local pre_state
  pre_state=$(_capture_main_state)

  echo "more changes" >> "$repo/app.ts"

  _guard_main_checkout "test" "$pre_state" || true

  [ "$_fail_called" = "false" ]
}

# Invariant: the on-exit sequence ai-run-issue-v2 runs (reattach REPO_ROOT
#   branch, then run the guard) restores the main checkout to its original
#   branch and SHA, even when an agent left REPO_ROOT on a different branch.
#   Mirrors _trap_on_exit: reattach first, guard second (defense-in-depth).
# Source: #295.
# Failure prevented: a run that crashes/exits mid-phase leaving REPO_ROOT on a
#   stray branch or detached HEAD — the operator's main checkout is corrupted.
# TS-port contract: whatever the TS orchestrator runs on exit must leave
#   REPO_ROOT on its pre-run branch at its pre-run SHA. Runtime-agnostic — git
#   branch/SHA state after driving the real _detach/_reattach/_guard functions.
@test "parity[#295]: on-exit reattach+guard restores REPO_ROOT branch after a run" {
  source "$REPO_ROOT/scripts/lib/guard-main-checkout.sh"
  source "$REPO_ROOT/scripts/lib/emit_event.sh"
  warn() { :; }
  orchestrator_fail() { return 1; }

  local repo="$BATS_TEST_TMPDIR/exit-restore"
  mkdir -p "$repo"
  git -C "$repo" init -q
  git -C "$repo" config user.email "t@t"
  git -C "$repo" config user.name "t"
  echo base > "$repo/app.ts"
  git -C "$repo" add app.ts
  git -C "$repo" commit -q -m init

  export REPO_ROOT="$repo"
  export WORKTREE_DIR="$BATS_TEST_TMPDIR/wt-exit"
  mkdir -p "$WORKTREE_DIR"
  export AI_RUN_EVENTS_FILE="$BATS_TEST_TMPDIR/ev-exit.jsonl"
  : > "$AI_RUN_EVENTS_FILE"

  local _branch _sha
  _branch=$(git -C "$repo" rev-parse --abbrev-ref HEAD)
  _sha=$(git -C "$repo" rev-parse HEAD)

  # Snapshot pre-detach state, as ai-run-issue-v2 does for the EXIT trap.
  local _exit_pre_state
  _exit_pre_state=$(_capture_main_state)

  _detach_main_head
  # Simulate an agent that switched the main checkout onto a stray branch.
  git -C "$repo" checkout -q -b agent-stray

  # The trap's documented sequence: reattach first, then guard.
  _reattach_main_head
  _guard_main_checkout "exit-trap" "$_exit_pre_state" || true

  # REPO_ROOT must be back on its original branch at its original SHA.
  [ "$(git -C "$repo" rev-parse --abbrev-ref HEAD)" = "$_branch" ]
  [ "$(git -C "$repo" rev-parse HEAD)" = "$_sha" ]
}

# Invariant: _detach_main_head detaches REPO_ROOT HEAD so an agent commit lands
#   on a detached HEAD (orphaned), and _reattach_main_head returns to the
#   original branch WITHOUT advancing it. This is the mechanism that stops a
#   leaked commit from moving main.
# Source: #295.
# Failure prevented: agent commits leaked onto local main, diverging from origin
#   (e.g. commit 6645816 in #290).
# TS-port contract: the TS detach/restore must leave the original branch at its
#   pre-run SHA after an agent commits, with the leaked commit unreachable.
#   Runtime-agnostic — drives the real _detach_main_head/_reattach_main_head.
@test "parity[#295]: _detach_main_head/_reattach_main_head keep main at its pre-run SHA" {
  source "$REPO_ROOT/scripts/lib/guard-main-checkout.sh"
  source "$REPO_ROOT/scripts/lib/emit_event.sh"
  warn() { :; }

  local repo="$BATS_TEST_TMPDIR/detach-fns"
  mkdir -p "$repo"
  git -C "$repo" init -q
  git -C "$repo" config user.email "t@t"
  git -C "$repo" config user.name "t"
  echo base > "$repo/app.ts"
  git -C "$repo" add app.ts
  git -C "$repo" commit -q -m init

  export REPO_ROOT="$repo"
  export AI_RUN_EVENTS_FILE="$BATS_TEST_TMPDIR/ev-detach.jsonl"
  : > "$AI_RUN_EVENTS_FILE"

  local _branch _pre_sha
  _branch=$(git -C "$repo" rev-parse --abbrev-ref HEAD)
  _pre_sha=$(git -C "$repo" rev-parse HEAD)

  _detach_main_head
  [ "$(git -C "$repo" rev-parse --abbrev-ref HEAD)" = "HEAD" ]   # detached

  # Agent commits while detached.
  echo leak > "$repo/leak.txt"
  git -C "$repo" add leak.txt
  git -C "$repo" -c user.email=t@t -c user.name=t commit -q -m "agent leak"
  local _leak_sha
  _leak_sha=$(git -C "$repo" rev-parse HEAD)
  [ "$_leak_sha" != "$_pre_sha" ]

  _reattach_main_head

  # Original branch restored and NOT advanced.
  [ "$(git -C "$repo" rev-parse --abbrev-ref HEAD)" = "$_branch" ]
  [ "$(git -C "$repo" rev-parse HEAD)" = "$_pre_sha" ]
  # The leaked commit is unreachable from the restored branch (orphaned).
  run git -C "$repo" merge-base --is-ancestor "$_leak_sha" "$_branch"
  [ "$status" -ne 0 ]
}

# Invariant: the runtime enforces artifact existence when `--expected-artifacts`
# is declared. When the agent exits 0 but the expected file is absent, the
# outcome is contract_violation (exit 1) rather than success (exit 0).
# Source: #297 (Part 1).
# Failure prevented: a recoverable agent miss (model generates text but never
#   calls Write) is treated as unrecoverable orchestrator_fail because the
#   runtime never checked whether the declared artifact existed.
# TS-port contract: the runtime MUST check existsSync on each declared
#   expectedArtifact after agent exit and set outcome=contract_violation +
#   missing_required_artifact if any is absent.
@test "parity[#297]: runtime enforces artifact existence when --expected-artifacts declared" {
  local runner="$REPO_ROOT/packages/infrastructure/src/agent/external-cli-runner.ts"

  # existsSync must be imported
  run grep -c "existsSync" "$runner"
  [ "$status" -eq 0 ]
  [ "$output" -ge 1 ]

  # MISSING_REQUIRED_ARTIFACT code must be referenced in the enforcement block
  run grep -c "MISSING_REQUIRED_ARTIFACT" "$runner"
  [ "$status" -eq 0 ]
  [ "$output" -ge 1 ]

  # outcome must be set to contract_violation in the enforcement block
  # (>=2: existing NO_OUTPUT block + new artifact block)
  run grep -c "outcome = 'contract_violation'" "$runner"
  [ "$status" -eq 0 ]
  [ "$output" -ge 2 ]

  # The enforcement check must reference input.expectedArtifacts
  # (>=3: type field + NO_OUTPUT guard + enforcement check)
  run grep -c "expectedArtifacts" "$runner"
  [ "$status" -eq 0 ]
  [ "$output" -ge 3 ]
}

# Invariant: plan-review retries the reviewer on contract_violation (exit 1)
# rather than immediately calling orchestrator_fail. Non-retryable exits (2, 3)
# still fail immediately.
# Source: #297 (Part 1).
# Failure prevented: a recoverable agent miss (model writes zero files) is
#   treated as unrecoverable failure, wasting compute and requiring manual re-run.
# TS-port contract: the TS plan-review orchestrator MUST retry the reviewer
#   on contract_violation outcomes rather than failing immediately.
@test "parity[#297]: plan-review retries reviewer on contract_violation (exit 1)" {
  local pr="$REPO_ROOT/scripts/lib/plan-review.sh"
  # Retry loop must exist in the reviewer error-handling path
  run grep -c "retry" "$pr"
  [ "$status" -eq 0 ]
  [ "$output" -ge 1 ]
  # Must distinguish exit 1 from other non-zero exits for retryability
  run grep -c "reviewer_ec -eq 1" "$pr"
  [ "$status" -eq 0 ]
  [ "$output" -ge 1 ]
  # Must have a bounded retry count parameter
  run grep -c "reviewer_retries" "$pr"
  [ "$status" -eq 0 ]
  [ "$output" -ge 1 ]
  # Must still call orchestrator_fail when retries exhausted
  run grep -c "retries exhausted" "$pr"
  [ "$status" -eq 0 ]
  [ "$output" -ge 1 ]
}

# Invariant: the CLI persists agent stdout/stderr to .ai-runs/ in the worktree
# when the agent outcome is not success, so failures are post-mortemable.
# Source: #297 (Part 2).
# Failure prevented: an agent run that fails with zero durable transcript
#   cannot be post-mortemed. The transcript path must be surfaced in stderr.
# TS-port contract: the TS run-agent MUST copy stdoutPath/stderrPath to
#   .ai-runs/ on non-success outcomes and log the path.
@test "parity[#297]: agent transcript persisted to .ai-runs/ on non-success outcomes" {
  local cli="$REPO_ROOT/apps/cli/src/run-agent.ts"

  # Must import copyFileSync
  run grep -c "copyFileSync" "$cli"
  [ "$status" -eq 0 ]
  [ "$output" -ge 1 ]

  # Must reference .ai-runs as the persistence directory
  run grep -c ".ai-runs" "$cli"
  [ "$status" -eq 0 ]
  [ "$output" -ge 1 ]

  # Must check outcome !== 'success' before persisting
  run grep -c "outcome !== 'success'" "$cli"
  [ "$status" -eq 0 ]
  [ "$output" -ge 1 ]

  # Must surface the transcript path via console.error
  run grep -c "Agent transcript saved to:" "$cli"
  [ "$status" -eq 0 ]
  [ "$output" -ge 1 ]
}

# Invariant: _lint_task_size warns (via emit_event) when a task-manifest entry
#   targets an oversized test file — line count > _TASK_SPLIT_MAX_LINES or
#   test-case count > _TASK_SPLIT_MAX_CASES. When _TASK_SPLIT_BLOCK is true,
#   the function returns exit 1 instead of warning.
# Source: #269.
# Failure prevented: a single agent invocation targeting a 1600+ line / 30-test
#   file exceeds context budget, compacts mid-task, and gets stuck (BLOCKED,
#   canRetry:false), blocking the entire run.
# TS-port contract: the TS lint phase must detect oversized test tasks using
#   configurable thresholds and surface them. Runtime-agnostic — drives
#   _lint_task_size through the real emit_event path.
@test "parity[#269]: _lint_task_size warns on oversized test-task files" {
  source "${REPO_ROOT}/scripts/lib/emit_event.sh"
  source "${REPO_ROOT}/scripts/lib/parse_tasks_helpers.sh"
  local test_dir
  test_dir=$(mktemp -d)
  trap "rm -rf $test_dir" EXIT
  export AI_RUN_EVENTS_FILE="${test_dir}/events.jsonl"
  export AI_RUN_DISPLAY_ID="parity-test-269"
  : > "$AI_RUN_EVENTS_FILE"
  export _TASK_SPLIT_MAX_LINES=500
  export _TASK_SPLIT_MAX_CASES=10
  export _TASK_SPLIT_BLOCK=false
  export WORKTREE_DIR="$test_dir"
  # Create a test file that exceeds the line threshold (501 lines > 500)
  local big_file="${test_dir}/src/__tests__/big.test.ts"
  mkdir -p "$(dirname "$big_file")"
  for _ in $(seq 1 501); do echo "// line"; done > "$big_file"
  # Add some test cases that exceed the count threshold (11 > 10)
  for _ in $(seq 1 11); do echo "it('case', async () => {})"; done >> "$big_file"
  # Create a manifest with the oversized test file
  local manifest="${test_dir}/task-manifest.json"
  cat > "$manifest" << 'JSON'
{
  "version": 1,
  "task_count": 2,
  "tasks": [
    { "n": 1, "title": "Update big test file", "files": ["src/__tests__/big.test.ts"] },
    { "n": 2, "title": "Update small config", "files": ["tsconfig.json"] }
  ]
}
JSON
  _lint_task_size "$manifest"
  # Verify an event was emitted with task_size.oversized type
  local events
  events=$(cat "$AI_RUN_EVENTS_FILE")
  echo "$events" | jq -e 'select(.type == "task_size.oversized")' >/dev/null || {
    echo "FAIL: no task_size.oversized event emitted"
    false
  }
  # Verify the event references task 1
  local task_num
  task_num=$(echo "$events" | jq -r 'select(.type == "task_size.oversized") | .metadata.taskNum')
  [[ "$task_num" == "1" ]] || {
    echo "FAIL: expected taskNum=1, got ${task_num}"
    false
  }
}
@test "parity[#269]: _lint_task_size returns error when _TASK_SPLIT_BLOCK is true" {
  source "${REPO_ROOT}/scripts/lib/emit_event.sh"
  source "${REPO_ROOT}/scripts/lib/parse_tasks_helpers.sh"
  local test_dir
  test_dir=$(mktemp -d)
  trap "rm -rf $test_dir" EXIT
  export AI_RUN_EVENTS_FILE="${test_dir}/events.jsonl"
  export AI_RUN_DISPLAY_ID="parity-test-269-block"
  : > "$AI_RUN_EVENTS_FILE"
  export _TASK_SPLIT_MAX_LINES=500
  export _TASK_SPLIT_MAX_CASES=10
  export _TASK_SPLIT_BLOCK=true
  export WORKTREE_DIR="$test_dir"
  local big_file="${test_dir}/src/__tests__/big.test.ts"
  mkdir -p "$(dirname "$big_file")"
  for _ in $(seq 1 501); do echo "// line"; done > "$big_file"
  local manifest="${test_dir}/task-manifest.json"
  cat > "$manifest" << 'JSON'
{
  "version": 1,
  "task_count": 1,
  "tasks": [
    { "n": 1, "title": "Update big test file", "files": ["src/__tests__/big.test.ts"] }
  ]
}
JSON
  set +e
  _lint_task_size "$manifest"
  local rc=$?
  set -e
  [[ $rc -eq 1 ]] || {
    echo "FAIL: expected exit 1 when block is true, got exit ${rc}"
    false
  }
}
@test "parity[#269]: _lint_task_size silently passes when no test files exceed thresholds" {
  source "${REPO_ROOT}/scripts/lib/emit_event.sh"
  source "${REPO_ROOT}/scripts/lib/parse_tasks_helpers.sh"
  local test_dir
  test_dir=$(mktemp -d)
  trap "rm -rf $test_dir" EXIT
  export AI_RUN_EVENTS_FILE="${test_dir}/events.jsonl"
  export AI_RUN_DISPLAY_ID="parity-test-269-pass"
  : > "$AI_RUN_EVENTS_FILE"
  export _TASK_SPLIT_MAX_LINES=500
  export _TASK_SPLIT_MAX_CASES=10
  export _TASK_SPLIT_BLOCK=false
  export WORKTREE_DIR="$test_dir"
  local small_file="${test_dir}/src/__tests__/small.test.ts"
  mkdir -p "$(dirname "$small_file")"
  for _ in $(seq 1 10); do echo "// line"; done > "$small_file"
  echo "it('works', () => {})" >> "$small_file"
  local manifest="${test_dir}/task-manifest.json"
  cat > "$manifest" << 'JSON'
{
  "version": 1,
  "task_count": 1,
  "tasks": [
    { "n": 1, "title": "Update small test", "files": ["src/__tests__/small.test.ts"] }
  ]
}
JSON
  _lint_task_size "$manifest"
  # Verify no task_size.oversized event was emitted
  local has_event
  has_event=$(jq -r 'select(.type == "task_size.oversized") | length' "$AI_RUN_EVENTS_FILE" 2>/dev/null || echo 0)
  [[ "$has_event" -eq 0 ]] || {
    echo "FAIL: unexpected task_size.oversized event emitted for small file"
    false
  }
}

# Invariant: Review artifacts with an invalid verdict (e.g., SPEC_PARTIAL)
#   are rejected by validate_review_artifacts (return non-zero). The
#   orchestrator must not silently accept a .result file containing a
#   value outside the allowed set.
# Source: #305 (was #286#issuecomment-off-contract).
# Failure prevented: Reviewer wrote SPEC_PARTIAL to the .result file;
#   orchestrator accepted it as valid, burned retries, and hard-failed.
# TS-port contract: whatever validates review artifacts in the TS
#   orchestrator must also reject invalid verdicts (values outside the
#   allowed set per review type).
@test "parity[#305]: validate_review_artifacts rejects invalid verdict" {
  # Source the library and extract validate_review_artifacts from ai-run-issue-v2
  SCRIPT_PATH="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/ai-run-issue-v2"
  source "${REPO_ROOT}/scripts/lib/review-contract.sh"
  # Stubs
  log() { :; }
  # Extract the function (post-extension)
  eval "$(awk '
    /^validate_review_artifacts\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) exit }
  ' "$SCRIPT_PATH")"
  local test_dir
  test_dir=$(mktemp -d)
  trap "rm -rf $test_dir" EXIT
  # Valid verdict: SPEC_PASS
  echo "SPEC_PASS" > "${test_dir}/spec-review-task-1.result"
  echo "No findings." > "${test_dir}/spec-review-task-1.md"
  run validate_review_artifacts "${test_dir}/spec-review-task-1.result" "${test_dir}/spec-review-task-1.md" SPEC_PASS SPEC_FAIL
  [ "$status" -eq 0 ]
  # Invalid verdict: SPEC_PARTIAL
  echo "SPEC_PARTIAL" > "${test_dir}/spec-review-task-2.result"
  echo "Findings here." > "${test_dir}/spec-review-task-2.md"
  run validate_review_artifacts "${test_dir}/spec-review-task-2.result" "${test_dir}/spec-review-task-2.md" SPEC_PASS SPEC_FAIL
  [ "$status" -ne 0 ]
  # Invalid verdict: QUALITY_PARTIAL (quality context)
  echo "QUALITY_PARTIAL" > "${test_dir}/quality-review-task-1.result"
  echo "Findings here." > "${test_dir}/quality-review-task-1.md"
  run validate_review_artifacts "${test_dir}/quality-review-task-1.result" "${test_dir}/quality-review-task-1.md" QUALITY_PASS QUALITY_FAIL
  [ "$status" -ne 0 ]
}
