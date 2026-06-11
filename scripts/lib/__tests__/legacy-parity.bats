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
