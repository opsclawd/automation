# Implementation Log - Task 4

## Summary of Work
Implemented and verified Task 4: Integrate blast-radius checks into the bounded Plan Review Loop.

- **Created Deterministic Plan Checker Tests:** Added comprehensive tests in `apps/api/src/__tests__/deterministic-plan-check.test.ts` to cover structural mismatch, signature changes, unresolved declarations, uncovered references, and sorting.
- **Implemented creation and integration of `createDeterministicPlanCheck`:** Wired the helper in `apps/api/src/deterministic-plan-check.ts` and integrated it with the `SignatureReferenceAnalyzerPort`.
- **Wired Deterministic Check in `compose.ts`:** Setup the signature analyzer, created the check function, and passed it to the `PlanReviewLoop`.
- **Updated Plan Review Loop:** Replaced the legacy `checkManifestSync` signature check with `checkDeterministicPlan` in `packages/application/src/plan-review/plan-review-loop.ts`, emitting structured signature blast radius failure events and handling deterministic fixing correctly.
- **Verification:** Ran build, typecheck, lint, and all test suites to confirm correctness and adherence to rules.

## Task 5: Derive trusted implicated files from whole-repository typecheck diagnostics

**Status**: DONE
**Commit**: 683ea03157be1c4cf7ee1dd845830e57660372fd

### What was implemented

1. **Extended `TypecheckResult` interface** (`packages/application/src/implement-step/types.ts`):
   - Added optional `implicatedFiles?: string[]` field to store trusted file paths derived from typecheck diagnostics

2. **Created `deriveTrustedImplicatedFiles` API** (`apps/api/src/typecheck-implicated-files.ts`):
   - Implements trust boundary: only returns files that exist and are contained within the worktree root
   - Normalizes paths (Windows backslashes, absolute paths, symlinks)
   - Filters out:
     - Files with excluded path segments (`node_modules`, `dist`, `coverage`, `.next`, `.ai-runs`, `.ai-tmp`)
     - Generated declaration files (`.d.ts`)
     - Files with unsupported extensions (only `.ts`, `.tsx`, `.mts`, `.cts` allowed)
     - Files outside the worktree root
     - Path traversal attacks (`../`)
   - Deduplicates and sorts results lexicographically

3. **Created comprehensive tests** (`apps/api/src/__tests__/typecheck-implicated-files.test.ts`):
   - 24 tests covering all behavioral invariants:
     - Normalizes existing in-worktree TypeScript diagnostic paths
     - Deduplicates and sorts implicated files
     - Rejects traversal and absolute paths outside the worktree
     - Rejects dependencies outputs caches orchestration artifacts and unsupported extensions
     - Fileless and unparsed diagnostics do not implicate files
     - Build failures and typecheck failures use the same trust filter
     - Symlink handling

4. **Updated `runTypecheck` function** (`apps/api/src/compose.ts`):
   - Populates `implicatedFiles` in both failure branches:
     - When build fails but typecheck passes
     - When typecheck fails
   - Uses `deriveTrustedImplicatedFiles(ctx.cwd, structuredErrors)` to compute trusted files

### Files changed
- `packages/application/src/implement-step/types.ts` - Added `implicatedFiles` field
- `apps/api/src/typecheck-implicated-files.ts` - New file with trust filter implementation
- `apps/api/src/__tests__/typecheck-implicated-files.test.ts` - New file with 24 tests
- `apps/api/src/compose.ts` - Import and use `deriveTrustedImplicatedFiles`

### Tests
- 24 tests pass in typecheck-implicated-files.test.ts
- 6 tests pass in parse-typescript-errors.test.ts
- All lint and prettier checks pass

