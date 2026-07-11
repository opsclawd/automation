# Implementation Log - Task 9: Implement POST /api/runs and mutate routes

Implemented `POST /api/runs` and updated mutation routes (`POST /api/runs/:runId/cancel`, `resume`, `retry`) to check context with `loadRepositoryForRun` using `strictMatch: true`.

## Changes Made:
- Implemented `POST /api/runs` in `apps/api/src/routes/runs.ts` to support run creation with canonical ID resolution.
- Updated the cancel, retry, and resume mutation routes to utilize `guardMutation` helper which calls `loadRepositoryForRun` with `strictMatch: true` to prevent unauthorized mutations when repository context is mismatched or missing.
- Updated the vitest suite in `apps/api/src/__tests__/runs-recovery-routes.test.ts` to supply repo context headers where needed, and added strict mismatch validation tests (returns 409 when context is missing, returns 404 when context is mismatched).
- Verified that all workspace tests pass, ESLint checks pass, and typechecking succeeds without issues.
