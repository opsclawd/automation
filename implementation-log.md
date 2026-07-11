# Implementation Log — Task 5: Gate plan review before every reviewer call

## Implementation Details

1. **Domain Model Extensions (`packages/domain/src/loop.ts`)**:
   - Extended the domain loop iteration model with `kind?: LoopIterationKind` (where `LoopIterationKind` is `'review' | 'deterministic_fix'`).
   - Made `reviewInvocationId` optional to allow deterministic fix iterations to start without a dummy review ID.
   - Updated `startIteration` typesafe signatures and runtime checks to enforce `reviewInvocationId` for review attempts and `fixInvocationId` for deterministic fix attempts, default missing kinds to `'review'` for backward compatibility, and consume iteration budget normally.

2. **Gated Plan Review (`packages/application/src/plan-review/plan-review-loop.ts`)**:
   - Intercepted all normal, trailing, and bonus reviewer calls with a pre-flight manifest check.
   - On manifest mismatch:
     - Emitted a `deterministic_fix` event with the exact diagnostic.
     - Started a fix-only iteration (kind: `deterministic_fix`) and invoked the fixer with `deterministic_fix` metadata.
     - Refreshed citations and completed the iteration as `'fixed'` or `'unresolved'`.
     - Re-checked before the reviewer call.
   - Avoided infinite loops when the fixer fails to resolve a mismatch: tracked previous mismatch diagnostics and state (unresolved outcomes with no changes), and suppressed duplicates.
   - Removed redundant post-reviewer checks.

3. **Database Round-Trip Persistence (`packages/infrastructure/src/sqlite/loop-repository.ts`)**:
   - Handled serialization and deserialization of the iteration `kind` without needing a schema migration. Derives `kind` based on whether `review_invocation_id` is an empty string or empty, returning `'deterministic_fix'` or `'review'` appropriately.

4. **Composition & Tests**:
   - Added unit tests for new domain iteration kind invariants and budget checks (`packages/domain/src/__tests__/loop.test.ts`).
   - Replaced plan-review-loop manifest tests with updated cases matching Task 5 gating rules, verifying mismatch intercepts, arbiter bypasses, persistent mismatch exhaustion, and trailing review skips (`packages/application/src/plan-review/__tests__/plan-review-loop.test.ts`).
   - Added a compose wiring test case verifying `planReviewRunFix` forwards diagnostics and sets the correct `deterministic_fix` invocation metadata (`apps/api/src/__tests__/compose-plan-review.test.ts`).

## Verification Results
- All unit, integration, and round-trip tests successfully passed across all packages (`pnpm -r test`).
- ESLint checks passed with 0 warnings (`pnpm lint`).
- TypeScript compiler checks passed without errors (`pnpm -r typecheck`).
- The project built successfully (`pnpm -r build`).
