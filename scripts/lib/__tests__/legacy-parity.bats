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
  source "$REPO_ROOT/scripts/lib/artifacts.sh"
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    run git -C "$REPO_ROOT" ls-files --error-unmatch -- "$f"
    [ "$status" -ne 0 ] || { echo "artifact is tracked (must be ignored): $f"; false; }
  done < <(orchestrator_artifact_paths)
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
}

# Invariant: the poller must NOT hard-terminate on blocked comments.
# blocked is a resting state that enters the READY/reactivation loop.
# The poller exits code 0 for all resting states (all_resolved,
# max_polls_reached, blocked) and code 2 for timeout cancellations
# (cancelled, timed_out).
# Source: M6-07 (#206).
# Failure prevented: blocked early-exit killed the watcher so new
#   reviewer activity after a block was silently dropped (PRs #302/#303).
# TS-port contract: exitCodeForTerminalState must return 0 for blocked
#   and all_resolved (resting), 2 for cancelled/timed_out (terminal).
@test "parity[#206]: blocked is a resting state (exit 0), not a hard terminal" {
  run grep -A8 'exitCodeForTerminalState' "$REPO_ROOT/apps/cli/src/run-pr-poll.ts"
  [ "$status" -eq 0 ]
  ! grep -n "'blocked'" "$REPO_ROOT/apps/cli/src/run-pr-poll.ts" | while IFS=: read -r ln _; do
    sed -n "${ln},\$p" "$REPO_ROOT/apps/cli/src/run-pr-poll.ts" | head -30 | grep -q "return 1" && exit 1
  done
}
# Invariant: all_resolved is a resting state (exit 0), not passed (terminal).
# Source: M6-07 (#206).
# Failure prevented: marking a resting run as 'passed' prevents future
#   reactivation — new activity after all_resolved would be silently dropped.
@test "parity[#206]: all_resolved maps to 'waiting', not 'passed'" {
  run grep -A10 'runStatusForTerminalState' "$REPO_ROOT/apps/cli/src/run-pr-poll.ts"
  [ "$status" -eq 0 ]
  ! grep -n "'all_resolved'" "$REPO_ROOT/apps/cli/src/run-pr-poll.ts" | while IFS=: read -r ln _; do
    sed -n "${ln},\$p" "$REPO_ROOT/apps/cli/src/run-pr-poll.ts" | head -20 | grep -q "'passed'" && exit 1
  done
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

# Invariant: When a reviewer writes artifacts to a wrong path (e.g.,
#   docs/spec-vs-implementation-reviews/), the recovery scanner copies them
#   to the expected path so the retry and downstream consumers can find them.
# Source: #305 (was #286 hard-failure — artifacts at wrong path).
# Failure prevented: Reviewer wrote .result/.md to docs/ subdirectory;
#   orchestrator couldn't find them, burned retries, hard-failed.
# TS-port contract: the TS orchestrator must also scan for and recover
#   artifacts written to off-contract paths within the worktree.
@test "parity[#305]: recover_off_contract_review_artifacts recovers from docs/ subdirectory" {
  source "${REPO_ROOT}/scripts/lib/review-contract.sh"
  local test_dir
  test_dir=$(mktemp -d)
  trap "rm -rf $test_dir" EXIT
  WORKTREE_DIR="$test_dir"
  log() { :; }
  # Simulate off-contract write: reviewer wrote to docs/spec-vs-implementation-reviews/
  mkdir -p "${test_dir}/docs/spec-vs-implementation-reviews"
  echo "SPEC_FAIL" > "${test_dir}/docs/spec-vs-implementation-reviews/TASK-3.result"
  echo "## Findings" > "${test_dir}/docs/spec-vs-implementation-reviews/TASK-3-spec-vs-implementation.md"
  # Also create a .md with the expected pattern name (the actual #286 case used a different .md name)
  echo "Findings here" > "${test_dir}/docs/TASK-3-task-3.md"
  run recover_off_contract_review_artifacts "spec" "3"
  [ "$status" -eq 0 ]
  # The .result should be recovered
  [ -f "${test_dir}/spec-review-task-3.result" ]
  [ "$(cat "${test_dir}/spec-review-task-3.result")" = "SPEC_FAIL" ]
}

# Invariant: the opencode adapter enforces artifact existence when
# expectedArtifacts is declared. When the agent exits 0 but the expected file
# is absent, the outcome is contract_violation (exit 1) rather than success.
# Source: #297 (PR review comment on opencode adapter path).
# Failure prevented: a recoverable agent miss (model generates text but never
#   writes the expected artifact) is treated as success because the opencode
#   adapter never checked whether the declared artifact existed.
# TS-port contract: the opencode adapter MUST check existsSync on each declared
#   expectedArtifact after agent exit and set outcome=contract_violation +
#   missing_required_artifact if any is absent.
@test "parity[#297]: opencode adapter enforces artifact existence when expectedArtifacts declared" {
  local adapter="$REPO_ROOT/packages/infrastructure/src/agent/opencode-adapter.ts"

  # existsSync must be imported
  run grep -c "existsSync" "$adapter"
  [ "$status" -eq 0 ]
  [ "$output" -ge 1 ]

  # MISSING_REQUIRED_ARTIFACT code must be referenced in the enforcement block
  run grep -c "MISSING_REQUIRED_ARTIFACT" "$adapter"
  [ "$status" -eq 0 ]
  [ "$output" -ge 1 ]

  # outcome must be set to contract_violation in the enforcement block
  # (>=2: existing NO_OUTPUT block + new artifact block)
  run grep -c "outcome = 'contract_violation'" "$adapter"
  [ "$status" -eq 0 ]
  [ "$output" -ge 2 ]

  # The enforcement check must reference request.expectedArtifacts
  run grep -c "expectedArtifacts" "$adapter"
  [ "$status" -eq 0 ]
  [ "$output" -ge 1 ]
}

# Invariant: opencode child processes receive PWD=<worktree> and never
#   inherit INIT_CWD from the parent pnpm process environment.
# Source: #311 (session directory drift → stranded result.json).
# Failure prevented: opencode session binds to the pnpm exec directory
#   (apps/cli/) instead of the worktree, writes result.json to the wrong
#   path, and the adapter finds MISSING_REQUIRED_ARTIFACT — permanently
#   blocking PR review comments.
# TS-port contract: the opencode-adapter must set PWD=request.cwd and
#   INIT_CWD=undefined in the child env passed to execa. This test
#   guards at the source-code level: grep the adapter for PWD and INIT_CWD
#   set as described.
@test "parity[#311]: opencode child env sets PWD=request.cwd and removes INIT_CWD" {
  run grep -c "PWD: request.cwd" "$REPO_ROOT/packages/infrastructure/src/agent/opencode-adapter.ts"
  [ "$status" -eq 0 ]
  [ "$output" -ge 1 ]

  run grep -c "INIT_CWD: undefined" "$REPO_ROOT/packages/infrastructure/src/agent/opencode-adapter.ts"
  [ "$status" -eq 0 ]
  [ "$output" -ge 1 ]
}

# Invariant: when result.json is missing at the worktree, the opencode adapter
#   scans apps/cli/ (the known drift target from #311) and auto-recovers the
#   artifact, annotating stderr with a DRIFT_WARNING.
# Source: #311 (session directory drift → stranded result.json).
# Failure prevented: a valid agent verdict written to apps/cli/result.json
#   instead of the worktree is silently dropped → comment permanently blocked.
# TS-port contract: the adapter must scan known stray locations as a defense-
#   in-depth backstop and recover found artifacts. The stray location list
#   must include at least 'apps/cli'.
@test "parity[#311]: opencode adapter scans apps/cli/ for stranded result.json" {
  run grep -c "'apps/cli'" "$REPO_ROOT/packages/infrastructure/src/agent/opencode-adapter.ts"
  [ "$status" -eq 0 ]
  [ "$output" -ge 1 ]

  run grep -c 'DRIFT_WARNING' "$REPO_ROOT/packages/infrastructure/src/agent/opencode-adapter.ts"
  [ "$status" -eq 0 ]
  [ "$output" -ge 1 ]

  # resultJsonPath must be set when result.json exists after normal or recovery path
  run grep -c 'resultJsonPath' "$REPO_ROOT/packages/infrastructure/src/agent/opencode-adapter.ts"
  [ "$status" -eq 0 ]
  [ "$output" -ge 1 ]
}

# Invariant: Token usage is extracted from opencode session `service=llm` lines
#   via a pure function (parseSessionLogUsage) and populated on
#   AgentInvocationResult.usage by the opencode adapter. The parse function
#   filters to service=llm/provider lines only — never matching agent transcript
#   content that happens to contain tokens={…}.
# Source: #307.
# Failure prevented: Token attribution stops working silently if the function is
#   removed or the wiring is deleted — profile tuning becomes guesswork again.
# TS-port contract: parseSessionLogUsage must exist as a pure exported function
#   filtering service=llm lines; the adapter must populate result.usage.
@test "parity[#307]: opencode adapter parses token usage from session logs" {
  run grep -c 'export function parseSessionLogUsage' "$REPO_ROOT/packages/infrastructure/src/agent/opencode-adapter.ts"
  [ "$status" -eq 0 ]
  [ "$output" -ge 1 ]
  run grep -c 'parseSessionLogUsage' "$REPO_ROOT/packages/infrastructure/src/agent/opencode-adapter.ts"
  [ "$status" -eq 0 ]
  [ "$output" -ge 2 ]
}

# Invariant: Agent usage is persisted to the agent_usage table and an agent.usage
#   event is emitted on the event bus after each agent invocation completes.
#   The router integrates AgentUsagePort for durable storage (one row per
#   invocation) and emits agent.usage events for downstream consumers (SSE).
# Source: #307.
# Failure prevented: Token data is lost silently if the insertion or event
#   emission is removed — downstream consumers (SSE, SQL views) get no data,
#   and profile tuning remains guesswork.
# TS-port contract: AgentRuntimeRouter must accept usageRepository, call
#   usageRepository.insert() when result.usage is present, and emit agent.usage
#   events via the event bus.
@test "parity[#307]: router persists usage and emits agent.usage event" {
  run grep -c 'usageRepository' "$REPO_ROOT/packages/infrastructure/src/agent/agent-runtime-router.ts"
  [ "$status" -eq 0 ]
  [ "$output" -ge 1 ]
  run grep -c "agent.usage" "$REPO_ROOT/packages/infrastructure/src/agent/agent-runtime-router.ts"
  [ "$status" -eq 0 ]
  [ "$output" -ge 1 ]
}

# Invariant: orchestrator_artifact_paths() returns the canonical artifact
#   filename list (source of truth). The list is source-controlled and any
#   new root-level orchestrator artifact MUST be added here first.
# Source: #280.
# Failure prevented: artifact lists in .gitignore, seed_excludes, mutation
#   guards, and agent prompts drift independently.
# TS-port contract: the TS orchestrator must reference the same canonical
#   list (or a port of it) for its equivalent guards.
@test "parity[#280]: orchestrator_artifact_paths returns expected canonical entries" {
  source "$REPO_ROOT/scripts/lib/artifacts.sh"
  run orchestrator_artifact_paths
  [ "$status" -eq 0 ]
  [[ "$output" == *"validation.headsha"* ]]
  [[ "$output" == *"review-fix-plan.json"* ]]
  [[ "$output" == *"review-task-manifest.json"* ]]
  [[ "$output" == *"review-triage.md"* ]]
  [[ "$output" == *"code-review.md"* ]]
  [[ "$output" == *"task-manifest.json"* ]]
  [[ "$output" == *"compound-draft.md"* ]]
  [[ "$output" == *"result.json"* ]]
}

# Invariant: guard_artifact_clean() removes a staged artifact from the index
#   so it cannot enter a commit even if .gitignore misses it.
# Source: #280.
# Failure prevented: an agent force-adds an artifact (git add -f), it enters
#   the index, and the next commit ships it in the PR.
# TS-port contract: the TS orchestrator's post-phase cleanup must also
#   unstage and delete known artifact paths.
@test "parity[#280]: guard_artifact_clean unstages a staged artifact" {
  source "$REPO_ROOT/scripts/lib/artifacts.sh"
  warn() { :; }
  emit_event() { :; }
  local repo="$BATS_TEST_TMPDIR/gac-repo"
  mkdir -p "$repo"
  git -C "$repo" init -q
  git -C "$repo" config user.email "t@e.com"
  git -C "$repo" config user.name "t"
  echo base > "$repo/app.ts"
  git -C "$repo" add app.ts
  git -C "$repo" commit -q -m init
  # Simulate an agent force-adding an artifact
  echo "abc123" > "$repo/validation.headsha"
  git -C "$repo" add -f validation.headsha
  # Verify it is staged
  git -C "$repo" diff --cached --name-only | grep -qxF "validation.headsha"
  # Run the guard
  guard_artifact_clean "$repo"
  # Verify it is no longer staged
  run git -C "$repo" diff --cached --name-only
  ! grep -qxF "validation.headsha" <<< "$output"
  # Verify the file was deleted from disk
  [ ! -f "$repo/validation.headsha" ]
}

# Invariant: hardened mutation guards (with artifact pathspec exclusions)
#   do NOT trip when the only diff against HEAD is a known orchestrator
#   artifact. Source file changes are still caught — exclusions are scoped
#   to known artifact paths only.
# Source: #280.
# Failure prevented: a tracked artifact (e.g. validation.headsha) is
#   rewritten and trips the mutation guard on every run, blocking all
#   runs until the artifact is untracked — even though no source was mutated.
# TS-port contract: the TS orchestrator mutation guards must also exclude
#   known orchestrator artifacts from diff checks.
@test "parity[#280]: hardened guard does not trip on artifact-only diffs" {
  source "$REPO_ROOT/scripts/lib/artifacts.sh"
  local repo="$BATS_TEST_TMPDIR/hg-repo"
  mkdir -p "$repo"
  git -C "$repo" init -q
  git -C "$repo" config user.email "t@e.com"
  git -C "$repo" config user.name "t"
  echo base > "$repo/app.ts"
  git -C "$repo" add app.ts
  git -C "$repo" commit -q -m init
  # Track an artifact (simulate the #273 regression)
  echo "abc123" > "$repo/validation.headsha"
  git -C "$repo" add validation.headsha
  git -C "$repo" commit -q -m "accidental artifact commit"
  # Modify the tracked artifact (as validate phase does every run)
  echo "def456" > "$repo/validation.headsha"
  # Unhardened guard: would trip (diff sees changed validation.headsha)
  run git -C "$repo" diff --exit-code HEAD
  [ "$status" -ne 0 ]
  # Hardened guard: should NOT trip (artifact excluded)
  local -a _art_excl=()
  while IFS= read -r _exc; do _art_excl+=("$_exc"); done < <(orchestrator_diff_exclusions)
  run git -C "$repo" diff --exit-code HEAD -- . "${_art_excl[@]}"
  [ "$status" -eq 0 ]
  # Source file changes are still caught
  echo "real change" >> "$repo/app.ts"
  run git -C "$repo" diff --exit-code HEAD -- . "${_art_excl[@]}"
  [ "$status" -ne 0 ]
}

# Invariant: guard_artifact_clean() is called inside _stash_and_conditionally_commit
#   before git add -A, so the orchestrator-created commit in fix-review-stash.sh
#   cannot sweep up known artifacts even if info/exclude is incomplete.
# Source: #280.
# Failure prevented: the orchestrator's own git add -A in _stash_and_conditionally_commit
#   stages artifacts (e.g. validation.headsha), committing them to the PR branch.
# TS-port contract: the TS fix-review stash/commit path must also exclude known
#   artifacts before staging.
@test "parity[#280]: guard_artifact_clean is called before git add -A in fix-review-stash.sh" {
  source "$REPO_ROOT/scripts/lib/artifacts.sh"
  local stash="$REPO_ROOT/scripts/lib/fix-review-stash.sh"
  # guard_artifact_clean must appear before git add -A
  local _guard_line _add_line
  _guard_line=$(grep -n 'guard_artifact_clean' "$stash" | head -1 | cut -d: -f1)
  _add_line=$(grep -n 'git.*add -A' "$stash" | head -1 | cut -d: -f1)
  [[ -n "$_guard_line" ]]
  [[ -n "$_add_line" ]]
  [[ "$_guard_line" -lt "$_add_line" ]]
}

# Invariant: seed_excludes() writes every entry from the canonical
#   orchestrator_artifact_paths() list into the worktree's info/exclude.
#   This closes the gap where a new artifact added to the centralized list
#   but not to the seed_excludes heredoc could be git add -A'd.
# Source: #280.
# Failure prevented: a new artifact type is added to the canonical list
#   but forgotten in seed_excludes → agent git add -A picks it up → committed.
# TS-port contract: the TS orchestrator's worktree initialization must also
#   exclude every entry from the canonical artifact list.
@test "parity[#280]: seed_excludes covers every entry in orchestrator_artifact_paths" {
  source "$REPO_ROOT/scripts/lib/artifacts.sh"
  local repo="$BATS_TEST_TMPDIR/se-repo"
  mkdir -p "$repo"
  git -C "$repo" init -q
  git -C "$repo" config user.email "t@e.com"
  git -C "$repo" config user.name "t"
  echo base > "$repo/app.ts"
  git -C "$repo" add app.ts
  git -C "$repo" commit -q -m init

  local ORIG_WORKTREE_DIR="$WORKTREE_DIR"
  export WORKTREE_DIR="$repo"
  log() { :; }
  emit_event() { :; }
  warn() { :; }

  # Source seed_excludes from ai-run-issue-v2
  source <(sed -n '/^seed_excludes()/,/^}/p' "$REPO_ROOT/scripts/ai-run-issue-v2")
  pushd "$repo" >/dev/null
  seed_excludes
  popd >/dev/null

  local exclude_file
  exclude_file="$repo/$(cd "$repo" && git rev-parse --git-common-dir)/info/exclude"

  # Every entry from the canonical list must be present
  while IFS= read -r artifact; do
    [[ -z "$artifact" ]] && continue
    run grep -qxF "$artifact" "$exclude_file"
    [ "$status" -eq 0 ] || { echo "artifact not in info/exclude: $artifact"; false; }
  done < <(orchestrator_artifact_paths)

  export WORKTREE_DIR="$ORIG_WORKTREE_DIR"
}

# Invariant: manifest/prose agreement is manifest-anchored and fence-immune.
#   _check_manifest_against_prose finds each manifest task by a column-0
#   "## Task n:" / "### Task n:" heading whose title matches the manifest title,
#   read from the RAW plan (no fence-stripping). A real heading is found even
#   when preceded by an unbalanced/forgotten code fence (#206), and in-range
#   example/fixture headings (a plan whose subject is task parsing, #315) do NOT
#   cause a false failure.
# Source: #315 (run failed on its own plan) / #206 (forgotten closing fence).
# Failure prevented: the naive _strip_fenced toggle mis-parsed plans with
#   unbalanced or nested example fences, silently stripping real task headers ->
#   "tasks missing from prose" / "not sequential" on a valid plan, blocking the run.
# TS-port contract: the TS task-parsing must anchor on the manifest (source of
#   truth, validated 1..task_count) and match task headers by number+title in the
#   raw plan text; it must NOT depend on balanced code fences. Pure decision over
#   plan text + manifest — runtime-agnostic.
@test "parity[#315]: manifest/prose check is manifest-anchored and fence-immune" {
  source "$REPO_ROOT/scripts/lib/parse_tasks_helpers.sh"
  local d
  d="$(mktemp -d)"

  # Plan whose fixtures contain in-range example "## Task n:" headings and an
  # intentionally unbalanced code fence — yet real tasks 1 and 2 are present.
  cat > "$d/plan.md" << 'PLAN'
### Task 1: Build the thing

```bash
cat > plan.md << 'INNER'
## Task 1: Example
```typescript
## Task 2: Example two
still unclosed
INNER
```

### Task 2: Test the thing
PLAN
  cat > "$d/manifest.json" << 'JSON'
{ "version": 1, "task_count": 2, "tasks": [{ "n": 1, "title": "Build the thing" }, { "n": 2, "title": "Test the thing" }] }
JSON

  run _check_manifest_against_prose "$d/plan.md" "$d/manifest.json"
  [ "$status" -eq 0 ] || { echo "expected pass, got: $output"; false; }

  # Fence-immunity: a real heading after a forgotten (odd) fence is still found,
  # and the missing-task diagnostic surfaces the odd-fence hint.
  cat > "$d/plan2.md" << 'PLAN'
### Task 1: Build the thing

```bash
echo only-one-fence
PLAN
  run _check_manifest_against_prose "$d/plan2.md" "$d/manifest.json"
  [ "$status" -ne 0 ]
  [[ "$output" == *"Task 2"* ]]
  [[ "$output" == *"unbalanced code fence"* ]]

  # #223/#147 regression: presence is by NUMBER only. Prose headings routinely
  # elaborate/reword the short manifest title — that MUST still validate (title
  # matching false-failed real plans and was removed).
  cat > "$d/plan3.md" << 'PLAN'
### Task 1: Add local config override tests (Part 1 — basic overrides and deep merge)

### Task 2: Export the adapter from index.ts and wire it up
PLAN
  cat > "$d/manifest3.json" << 'JSON'
{ "version": 1, "task_count": 2, "tasks": [{ "n": 1, "title": "Add local config override tests — basic overrides and deep merge" }, { "n": 2, "title": "Export CodexAgentAdapter" }] }
JSON
  run _check_manifest_against_prose "$d/plan3.md" "$d/manifest3.json"
  [ "$status" -eq 0 ] || { echo "elaborated prose titles must validate, got: $output"; false; }

  rm -rf "$d"
}

# Invariant: extract_task_text is immune to unbalanced code fences — real task
#   headings after an unclosed fence opener are found via raw column-0 grep,
#   not lost to the _strip_fenced toggle.
# Source: #315 (this issue).
# Failure prevented: a plan with a forgotten closing fence causes validation to
#   green-light but extract_task_text reads the wrong (or no) task body because
#   the old toggle treats everything after an odd fence as fenced.
# TS-port contract: the TS extraction must locate headings with raw column-0
#   grep, never depend on fence-state tracking.
@test "parity[#315]: extract_task_text finds headings past an unbalanced fence" {
  source "${REPO_ROOT}/scripts/lib/parse_tasks_helpers.sh"
  local test_dir
  test_dir=$(mktemp -d)
  trap "rm -rf $test_dir" EXIT
  cat > "$test_dir/plan.md" << 'PLAN'
## Task 5: Far downstream task
This is real task body after the unclosed fence.
PLAN
  cat > "$test_dir/plan-with-unbalanced.md" << 'PLAN'
## Task 1: Early task
Early body.
```
unclosed fence — everything below is treated as fenced by old toggle
## Task 5: Far downstream task
This is real task body after the unclosed fence.
PLAN
  # Without unbalanced fence, Task 5 is found normally.
  run extract_task_text "$test_dir/plan.md" "Far downstream task" "5"
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "real task body"
  # With unbalanced fence, Task 5 is still found (old fence toggle would skip it).
  run extract_task_text "$test_dir/plan-with-unbalanced.md" "Far downstream task" "5"
  [ "$status" -eq 0 ]
  echo "$output" | grep -q "real task body"
}

# Invariant: extract_task_commit_msg is immune to unbalanced code fences —
#   uses the same raw column-0 grep as extract_task_text.
# Source: #315 (this issue).
# Failure prevented: the old toggle-based heading finder misses the real
#   heading after an unclosed fence, returning a fallback commit message
#   instead of the one documented in plan.md.
# TS-port contract: the TS extraction must locate headings with raw column-0
#   grep, never depend on fence-state tracking.
@test "parity[#315]: extract_task_commit_msg finds commit msg past an unbalanced fence" {
  source "${REPO_ROOT}/scripts/lib/parse_tasks_helpers.sh"
  local test_dir
  test_dir=$(mktemp -d)
  trap "rm -rf $test_dir" EXIT
  cat > "$test_dir/plan.md" << 'PLAN'
```
unclosed fence
## Task 2: Second task
Body.
git commit -m "feat: real commit msg here"

## Task 3: Third task
PLAN
  result=$(extract_task_commit_msg "$test_dir/plan.md" "Second task" "fallback" "2")
  [ "$result" = "feat: real commit msg here" ] || {
    echo "FAIL: expected 'feat: real commit msg here', got '$result'"
    false
  }
}
