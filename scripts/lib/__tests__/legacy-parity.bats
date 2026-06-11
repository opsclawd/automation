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
