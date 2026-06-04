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
