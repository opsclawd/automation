# Implementation Log - Task 2

## Status
DONE

## What was implemented
All components and pages required for Task 2: Build global Repository navigation and the filterable global Run view:
- **RepositorySelector.tsx**: A client-side selector component that lets the user choose a repository and navigates to the corresponding repository overview route or home (`/`).
- **RunFilters.tsx**: GET form filter for status/repository.
- **RunTable.tsx**: Displays runs with repository column and unknown/unregistered fallback rendering.
- **RunPagination.tsx**: Next/previous links that preserve status and repository filter parameters in `URLSearchParams`.
- **Header.tsx**: Integrates the `RepositorySelector` loaded server-side with `/api/repositories?all=1`.
- **page.tsx**: Scopes global lists to optional `repositoryId`, status, and offset/page.
- **globalSetup.ts**: Standardized Playwright database schema creation and data-seeding with deterministic ID hashing.

## Tests and Results
Ran the E2E verification suite:
- `e2e/smoke.spec.ts`
- `e2e/pr-review-tab.spec.ts`
- `e2e/review-fix-tab.spec.ts`
- `e2e/run-detail-timeline.spec.ts`

All 16 E2E tests passed successfully.
All unit tests passed.
Project builds, typechecks, and lints cleanly without warnings or errors.

## Files changed/created
- `apps/web/src/components/RepositorySelector.tsx`
- `apps/web/src/components/RunFilters.tsx`
- `apps/web/src/components/RunTable.tsx`
- `apps/web/src/components/RunPagination.tsx`
- `apps/web/src/components/Header.tsx`
- `apps/web/src/app/page.tsx`
- `apps/web/e2e/globalSetup.ts`
- `apps/web/e2e/smoke.spec.ts`
- `apps/web/e2e/pr-review-tab.spec.ts`
- `apps/web/e2e/review-fix-tab.spec.ts`
- `apps/web/e2e/run-detail-timeline.spec.ts`
