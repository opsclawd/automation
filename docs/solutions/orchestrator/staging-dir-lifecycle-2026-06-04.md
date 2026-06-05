---
module: orchestrator
tags: [staging, lifecycle, cleanup, trap, bash]
problem_type: resource-leak
date: 2026-06-04
---

# Empty staging directories leak in .ai-worktrees/

## Problem

`scripts/ai-run-issue-v2` unconditionally created `.ai-worktrees/issue-N-staging/`
in the setup block, but only populated it inside the `read_issue` phase. Resumed
runs and failed/aborted runs skipped `read_issue`, leaving empty staging dirs.

## Root Cause

Setup actions with side effects (`mkdir -p`) were not scoped to the phase that
consumes them. Same class of bug as the `seed_excludes` conditional-logic gap.

## Fix

1. Move `mkdir -p "${ISSUE_STAGING_DIR}"` from the setup block into the
   `read_issue` phase, just before the first write.
2. Add a `trap cleanup_staging EXIT` handler to clean up the staging dir on
   any exit path (success, failure, signal).
3. Add a one-time sweep of empty `issue-*-staging` dirs on startup using
   `find -mmin +5` + `rmdir` (safe — only removes truly empty dirs older
   than 5 minutes, avoiding a race with concurrent runs).

## Pattern

**Any setup action with side effects (mkdir, file creation, env mutation) must
be scoped to the phase that consumes it.** If an action is only needed in one
phase, it must be defined inside that phase's block — not in the top-level
setup. Defensive cleanup via `trap EXIT` ensures no leaks on error paths.

## Concurrency refinements (PR #199 review loop)

The naive cleanup design above is unsafe when two orchestrators may touch the
staging area. The review loop on PR #199 hardened it through a cascade where **each
cleanup fix introduced a new TOCTOU race** — the characteristic signature of
concurrent cleanup in bash. The final design:

1. **Global sweep, not per-issue, but age-gated.** Sweep all `issue-*-staging` dirs
   with `find -mmin +5` + `rmdir` (rmdir only removes *empty* dirs). The 5-minute
   age threshold is stateless and far exceeds the actual race window (seconds between
   a concurrent run's `mkdir -p` and its first write). A per-issue-only sweep (the
   approach in the original issue #124 compound) was reverted during review because
   it left historical empty dirs unclaimed and contradicted the documented design.

2. **`trap` deletes only dirs it owns.** The `cleanup_staging` trap used unconditional
   `rm -rf`, so two overlapping same-issue runs could delete each other's data. Guard
   it with a `.owner-${BASHPID}` marker written into the staging dir; the trap deletes
   only when its own marker is present.

3. **Owner markers create a new leak vector.** A run SIGKILL'd after writing
   `.owner-<pid>` but before copying issue files leaves a non-empty dir (the marker)
   that the empty-only sweep never removes. The sweep must additionally detect
   owner-marker-only dirs whose PIDs are all dead (`kill -0`) and remove them.

4. **Wildcard marker deletion races with fresh markers.** `rm -f .owner-*` in the
   dead-PID sweep can delete a *live* concurrent run's freshly-written marker. Collect
   the specific dead-marker paths into an array during the `kill -0` scan, then delete
   only those exact paths — never a wildcard.

**Meta-lesson:** concurrent cleanup logic in bash exhibits a fix cascade — every
defensive measure interacts with the others to open a narrower race. When a design
assumption ("only one orchestrator per issue") is enforced by **convention** (branch
naming, GitHub labels) rather than code, automated reviewers will keep flagging the
residual gap; decline explicitly with the invariant rather than adding locking the
design scoped out. See
`docs/solutions/orchestrator/pr-review-loop-failure-modes-2026-06-04.md` (§5 fix
cascade).
