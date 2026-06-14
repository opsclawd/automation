---
title: Main-checkout leak guard — agent edits via absolute paths, plus bash `local` and guard-ordering footguns
date: 2026-06-04
category: orchestrator
module: scripts
problem_type: infrastructure-safety
component: guard-main-checkout
symptoms:
  - agent invoked with --cwd <worktree> writes source files into the main repo checkout
  - 27 uncommitted source files left in the main checkout after a plan-write phase timed out
  - agent switches branches in the main checkout; guard rewinds the wrong branch
  - `bash: local: can only be used in a function` aborts the script before the guarded code runs
  - leak cleanup never runs because the agent timed out and orchestrator_fail exited first
root_cause: agent_addresses_files_by_absolute_repo_root_path_bypassing_cwd
resolution_type: code_fix
severity: high
related_components:
  - scripts/lib/guard-main-checkout.sh
  - scripts/ai-run-issue-v2
  - scripts/ai-pr-review-poll
  - scripts/lib/__tests__/main-checkout-guard.bats
tags:
  - main-checkout-guard
  - worktree
  - bash-local
  - guard-ordering
  - agent-contract
  - plan-write
---

# Main-Checkout Leak Guard

## Problem

A phase agent invoked with `--cwd <worktree>` can still write files into the **main
repo checkout** when it addresses files by absolute repo-root paths — `--cwd` only
sets the process working directory, it does not sandbox absolute paths. Observed on
issue #141: 27 uncommitted source files leaked into the main checkout after a
`plan-write` phase that should only have produced `plan.md`, then timed out and was
misclassified as a config/timeout error rather than a contract violation.

## Solution

Extract the main-checkout guard (originally inline in `ai-pr-review-poll`) into a
shared library `scripts/lib/guard-main-checkout.sh`, sourced by both
`ai-pr-review-poll` and `ai-run-issue-v2`. Wrap **every** `run-agent.ts` invocation
with `_capture_main_state` before and `_guard_main_checkout` after. The guard
compares the main checkout's dirty-state and HEAD SHA before/after the agent and
auto-resets on leak.

### Guard event types and actions

| Event | When | Action |
|---|---|---|
| `<label>.main_leak_detected` | dirty or HEAD-moved after a clean pre-state | auto-reset (`git reset --hard HEAD` or `--hard <sha>` + `git clean -fd`) |
| `<label>.main_dirty_preexisting` | dirty after, was dirty before | skip reset to preserve developer work |
| `<label>.main_leak_unsafe_recovery` | HEAD moved AND was dirty before | refuse auto-reset; manual cleanup required |

The `<label>` is caller-controlled (`plan-write`, `implement-task-3`,
`post-pr-review`) so each event has a unique type prefix for the failure classifier.

### plan-write contract enforcement (worktree side)

Separately, enforce that `plan-write` only changes `plan.md`/`design.md`/`.gitignore`
in the *worktree* via `git -C "$WORKTREE_DIR" diff --name-only HEAD` plus an untracked
check, failing on any source-file modification.

## Three footguns that took multiple review rounds (the durable lessons)

### 1. `local` at top-level under `set -e` aborts the script

`ai-run-issue-v2` phase blocks are **top-level** (not function-wrapped). `local`
outside a function triggers `bash: local: can only be used in a function`, and under
`set -e` this exits the script *before* the intended code runs. This was introduced
repeatedly (PR #152 fixed it three times) because writing `local _var=value` is a
natural reflex for bash authors, and inline `# comment; local _x=0;` constructions
hide the `local` mid-line.

**Rule:** in `ai-run-issue-v2`, top-level phase code must use plain assignment
(`_var=value`), never `local`. `local` is only valid inside the named helper
functions (`run_implementer`, `run_spec_reviewer`, etc.). Detection:
`grep -nE '^\s*local ' scripts/ai-run-issue-v2` outside function bodies.

### 2. The guard must run BEFORE terminal error handling, not after

If the guard/contract-check is placed after the `$_agent_ec` case-block, an agent
that both leaks **and** times out (exit 2) never gets cleaned up: `orchestrator_fail`
calls `exit 1` first. PR #152 had to reorder the guard and `check_branch_after_agent`
to run *before* the `orchestrator_fail` branches in 4 review phases. This is the same
class as the failure-classification guard discovered in
`docs/solutions/orchestrator/invocation-based-failure-classification-2026-05-29.md`:
cleanup and detection that must survive an error path cannot be placed after the
error-handling that exits.

**Rule:** capture-before, guard-after-but-before-fail. The ordering is:
agent invocation → `_guard_main_checkout` + contract check → exit-code branches.

### 3. Branch restoration ordering when the agent switched branches

When an agent runs `git -C "$REPO_ROOT" checkout <other-branch>`, the guard's
HEAD-moved path must `checkout` back to the pre-agent branch **before**
`reset --hard <expected_sha>`, or it corrupts whatever branch the agent left active.
Three rounds of refinement (PR #152):
1. reset-before-checkout — wrong (corrupts the other branch)
2. checkout-then-reset with `|| true` — unsafe when checkout fails on dirty target
3. final: verify current branch equals pre_branch after the checkout attempt; if
   not, emit `unsafe_recovery` and bail without resetting.

**Hidden constraint:** an agent can switch to a **same-SHA branch** without moving
HEAD. A SHA-only comparison misses this. The guard needs a branch-name drift check
in addition to the SHA check.

### 4. Pre-existing dirty state must not early-return past branch restoration

An early `return 0` in the dirty path (`if _dirty && pre_was_dirty`) skips the
end-of-function branch-restore block, leaving main on the wrong branch when the agent
only switched branches without dirtying. Restructure `if/return/.../fi` to `if/else`
so both sub-paths fall through to branch restoration.

## Library contract

`guard-main-checkout.sh` calls `warn()` and `emit_event()` but does not define them —
the calling scripts provide them (`ai-run-issue-v2` provides `warn()`; both source
`emit_event.sh`). Tests must stub: `log() { :; }; warn() { :; }`. Use
`_guard_worktree_dir()` to support both env vars (`WORKTREE_DIR` for
`ai-run-issue-v2`, `POLL_WORKTREE` for `ai-pr-review-poll`); it no-ops when neither
is set or either equals `REPO_ROOT`.

## When adding a new agent invocation phase

```bash
_main_state_before=$(_capture_main_state)
# ... run-agent.ts invocation ...
_guard_main_checkout "<phase-label>" "$_main_state_before"   # BEFORE any orchestrator_fail
# ... exit-code handling ...
```

Preserve the `ai-pr-review-poll` callsite's explicit `"post-pr-review"` label (not
`"$phase"`) to keep existing telemetry event types stable.

## Related

- `docs/solutions/orchestrator/bash-pipeline-exit-code-trap-2026-05-26.md` — `set -e` / PIPESTATUS footguns in the same scripts
- `docs/solutions/orchestrator/staging-dir-lifecycle-2026-06-04.md` — same "scope side effects, clean up on every exit path" discipline
- `docs/solutions/orchestrator/worktree-exclude-seeding-2026-05-18.md` — sibling worktree-hygiene guard
