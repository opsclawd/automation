# Task 6 Implementation Log: Update invariant audit rows 6-12

**Date:** 2026-06-30
**Task Status:** DONE

## Overview
We have completed Task 6 of the implementation plan, updating rows 6-12 of `docs/invariant-audit.md`.

## Changes Implemented
1. **Invariant 7:** Cited `packages/application/src/pr-review/poll-task-runner.ts` using `markReplied()` and `packages/application/src/pr-review/__tests__/poll-task-runner-reply-order.test.ts`. Marked as `covered`.
2. **Invariant 8:** Cited `packages/application/src/run-validation.ts`, `packages/application/src/__tests__/run-validation.test.ts`, and `packages/infrastructure/src/validation/__tests__/validation-adapter.test.ts`. Marked as `covered`.
3. **Invariant 9:** Cited the existing implement-step loop exhaustion test `packages/application/src/implement-step/__tests__/implement-step-loop.test.ts` and review-fix loop exhaustion test `packages/application/src/review-fix/__tests__/review-fix-loop.test.ts`. Marked as `covered`.
4. **Invariant 10:** Defined the covered minimum evidence set for the issue: validation failures include failed command stdout/stderr paths plus `validate/validation-result.json` and `validate/failure.json`; PR-review blocked/retry state and poll terminal state are persisted; Loop exhaustion returns an explicit `needs_human_review` or failure outcome. Marked as `covered`.
5. **Invariant 11:** Cited REST route confirmation tests (`apps/api/src/__tests__/runs-recovery-routes.test.ts`) and new CLI confirmation tests (`apps/api/src/__tests__/cli-runs-resume-confirmation.test.ts`). Marked as `covered`.
6. **Invariant 12:** Clarified that `recordPoll()` records poll count and terminal state while `PrReviewPoller` owns `nextPollAt` scheduling. Marked as `covered`.
7. **Summary Table & GAPs:** Updated summary table rows for 7, 10, and 11 from `GAP` to `covered`. Updated the final GAP assignment list to remove the sub-issue #397 entirely since all its associated invariants (7, 10, and 11) are now fully covered. Adjusted the total GAP count to 4.

## Verification
The verification commands were executed and returned the expected structure and status:
- `sed -n '/^## Group 6/,/^## Summary/p' docs/invariant-audit.md` (verified Group 6-12 detail section)
- `sed -n '/^| 6 /,/^\*\*GAPs:/p' docs/invariant-audit.md` (verified summary table and remaining GAPs list)
