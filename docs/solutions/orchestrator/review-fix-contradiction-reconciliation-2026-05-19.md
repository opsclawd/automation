---
title: Review/fix contradiction reconciliation — re-run review once before aborting
date: 2026-05-19
category: orchestrator
module: scripts
component: review-fix-loop
problem_type: contradiction
symptoms:
  - Orchestrator aborts with "reviews failing ... fix-agent reported no fixes"
  - Review .result says FAIL but fix-review says DONE_NO_FIXES_NEEDED
  - Most likely cause: stale/wrong .result sentinel, not real defect
root_cause: review_agent_result_sentinel_mismatch
resolution_type: pattern
severity: high
related_components:
  - scripts/ai-run-issue-v2
tags:
  - contradiction-reconciliation
  - review-fix-loop
  - agent-contract
---

# Review/Fix Contradiction Reconciliation — Re-run Review Once Before Aborting

## Problem

When the review phase reports `QUALITY_FAIL` (or `SPEC_FAIL`) but the subsequent `fix-review` agent returns `DONE_NO_FIXES_NEEDED`, the orchestrator previously failed immediately with "reviews failing ... fix-agent reported no fixes".

This is a **contradiction**, not a legitimate failure. Fix-review says "nothing is wrong" while review's `.result` says "something is wrong." The most likely root cause is a stale or incorrect `.result` sentinel.

## Solution

Insert `handle_contradiction_reconciliation()` in the review-fix loop. When `FIX_STATUS == DONE_NO_FIXES_NEEDED` and at least one review says FAIL:

1. Re-run the offending review once via `rerun_reviewer_once`
2. If contradiction persists, fail with `reviews_inconsistent` diagnostic

## Implementation

### `handle_contradiction_reconciliation()` function

```bash
handle_contradiction_reconciliation() {
  local fix_status="$1"
  local spec_status="$2"
  local quality_status="$3"
  # ...
  if [[ "$fix_status" != "DONE_NO_FIXES_NEEDED" ]]; then
    CONTRADICTION_ACTION="none"
    return
  fi
  if [[ "$spec_status" == "FAIL" || "$quality_status" == "FAIL" ]]; then
    if [[ "$CONTRADICTION_RETRIED" == "1" ]]; then
      CONTRADICTION_ACTION="already_retried"
      return
    fi
    # Re-run failing reviews
    if [[ "$spec_status" == "FAIL" ]]; then
      rerun_reviewer_once "spec" ...
    fi
    if [[ "$quality_status" == "FAIL" ]]; then
      rerun_reviewer_once "quality" ...
    fi
    CONTRADICTION_RETRIED=1
    # Re-resolve statuses
    resolve_result ...
    CONTRADICTION_ACTION="resolved"
    return
  fi
  CONTRADICTION_ACTION="none"
}
```

### Call site in review-fix loop

```bash
elif [[ "$FIX_STATUS" == "DONE_NO_FIXES_NEEDED" ]]; then
  handle_contradiction_reconciliation \
    "$FIX_STATUS" "$SPEC_STATUS" "$QUALITY_STATUS" \
    "$TASK_NUM" "$task_title" "$TASK_TEXT" \
    "$BASE_SHA" "$HEAD_SHA" "$IMPL_REPORT"

  if [[ "$CONTRADICTION_ACTION" == "resolved" ]]; then
    break
  fi
  orchestrator_fail "reviews_inconsistent: Task ${TASK_NUM} — review says FAIL ..."
fi
```

## Key Design Decisions

1. **Retry the review, not fix-review** — contradiction indicates the review's `.result` is likely stale/wrong
2. **One retry max per task** — `CONTRADICTION_RETRIED` counter reset at start of each task iteration
3. **Reuse `rerun_reviewer_once`** — same cleanup + re-run mechanics as agent contract hardening
4. **`CONTRADICTION_ACTION` as return mechanism** — Bash functions can't return strings; uses global

## Counter Placement

Reset at the start of each task iteration (inside the `while IFS= read -r ...` loop):

```bash
IMPL_STATUS="DONE"
HEAD_SHA=""
REVIEW_LOOPS=0
CONTRADICTION_RETRIED=0
```

## Tests

`scripts/lib/__tests__/contradiction_retry.bats` — 6 tests:

| Test                                                    | Verifies                                 |
| ------------------------------------------------------- | ---------------------------------------- |
| `QUALITY_FAIL + DONE_NO_FIXES_NEEDED triggers re-run`   | Only quality reviewer re-run             |
| `both reviews FAIL triggers re-run of both`             | Both reviewers re-run                    |
| `retry exhausted: second contradiction fails`           | `CONTRADICTION_ACTION=already_retried`   |
| `both reviews PASS skips retry`                         | `CONTRADICTION_ACTION=none`              |
| `post-retry resolve_result re-check — resolves to PASS` | Function detects resolution              |
| `emit_event includes iteration field`                   | `EMIT_EVENT_ARGS` contains `iteration=N` |

## Gotchas

1. **`SPEC_STATUS` and `QUALITY_STATUS` are updated as globals** — the function calls `resolve_result` and assigns to globals used by the caller's loop
2. **Resume behavior: counter is lost** — if orchestrator interrupted during retry and resumed, counter resets, contradiction re-detected (safe but wasteful)
3. **`IMPL_REPORT` is captured before the contradiction block** — correct value for spec re-runs
