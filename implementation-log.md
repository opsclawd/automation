# Implementation Log - Task 1

## Status
DONE

## What was implemented
1. **Added the snapshot seam**:
   - Added the `captureSnapshot` port signature to `PlanReviewLoopDeps` in `packages/application/src/plan-review/types.ts`.
   - Wired `captureSnapshot` inside the composition root `apps/api/src/compose.ts` utilizing the local `computeSnapshot` helper.
   - Captured initial snapshot in `plan-review-loop.ts` during `initial_full` phase when the review fails and the reviewer did not supply a snapshot.
   - Updated composition assertions in `apps/api/src/__tests__/compose-plan-review.test.ts` to verify `captureSnapshot` is successfully wired in the constructor of `PlanReviewLoop`.

2. **Added core one-shot verification transition**:
   - Added local state flags `pendingPostReopenVerification` and `postReopenVerificationUsed` in `PlanReviewLoop`.
   - Set `pendingPostReopenVerification = finalFullGrantUsed` when a `final_full` P1 finding reopens the delta cycle.
   - Cleared the marker on failed/cannot-fix and contradiction exits so it doesn't leak into subsequent loops.
   - Intercepted loop execution at the exhaustion boundary when `iterationIndex === loop.maxIterations` and verification conditions are met.
   - Ran post-reopen verification: performed deterministic plan check, captured snapshot, ran `final_full` review, and resolved or exhausted appropriately.

## What was tested
- Ran Vitest unit/integration tests matching "post-reopen final_full verification — transition" inside `packages/application/src/plan-review/__tests__/plan-review-loop.test.ts`.
- Verified compose test "wires planReviewCheckDeterministicPlan" inside `apps/api/src/__tests__/compose-plan-review.test.ts`.
- Verified typechecking passes cleanly across the workspace.
- Ran ESLint check verifying no style/unused-var violations are present.
- Ran dependency cruiser verifying clean layering structure.

## Files changed
- `packages/application/src/plan-review/types.ts`
- `packages/application/src/plan-review/plan-review-loop.ts`
- `packages/application/src/plan-review/__tests__/plan-review-loop.test.ts`
- `apps/api/src/compose.ts`
- `apps/api/src/__tests__/compose-plan-review.test.ts`
