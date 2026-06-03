---
title: Unified completion predicate — single source of truth for task completion
date: 2026-06-02
category: orchestrator
module: scripts
problem_type: divergence
component: resume-oracle
symptoms:
  - Resume oracle rewinds past completed tasks after divergence fix
  - Resume-path bugs invisible in happy-path testing
  - Duplicated completion logic drifts when guards added to one path
root_cause: duplicated_logic
resolution_type: pattern
severity: high
related_components:
  - scripts/ai-run-issue-v2
  - scripts/lib/parse_tasks_helpers.sh
  - scripts/lib/__tests__/task_completion.bats
tags:
  - completion-predicate
  - resume-oracle
  - defense-in-depth
  - sha-range
  - single-source-of-truth
---

# Unified Completion Predicate

## Problem

The orchestrator had two independent implementations of "is task N complete?":
the resume oracle (`get_task_completion_status` / `find_first_incomplete_task`)
and the in-loop task execution path. These drifted apart five times in PR #166,
each divergence surfacing as a resume-path bug.

## Solution

Extract two shared functions that both paths call:

1. **`is_task_complete(task_n)`** — returns 0/1, echoes status string
   (`"complete"`, `"review-needed"`, `"implementing"`, `"pending"`).
   Checks: impl success → review artifacts valid → reviews pass or deviation.
   `get_task_completion_status()` is now a thin wrapper.

2. **`get_task_review_range(task_n)`** — sets `REVIEW_BASE_SHA` and
   `REVIEW_HEAD_SHA` globals from persisted `.basesha.log` / `.headsha.log`
   markers, with git fallbacks. Both the resume-into-review path and
   the defense-in-depth check call this.

3. **Defense-in-depth** replaced with `is_task_complete()` — stronger than
   the previous check because it also validates review artifacts.

## Pattern

When two code paths answer the same question, extract a single predicate.
Test it independently. Make both paths call the predicate. Future guards
added to the predicate automatically apply to both paths.

## References

- Issue: #170
- PR #166 (where divergences were found and fixed)
- Design: design.md in issue worktree
