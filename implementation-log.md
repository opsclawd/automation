# Task 5 Implementation Log

## Status
DONE

## What Was Implemented
- Created migration `0016-add-repo-id-to-runs.ts` (version 16) adding nullable `repo_id TEXT` and composite index `idx_runs_repo_issue_status` on `(repo_id, issue_number, status)` to the `runs` table.
- Registered migration 16 in `packages/infrastructure/src/sqlite/migrations.ts`.
- Added `repo_id: string | null` to the internal `RunRow` schema.
- Updated database queries in `RunRepository` (`insert`, `insertIfNoActive`, `findByIssueNumber`, `updateStatusByIssueNumber`) to filter/save by repository identity.
- Updated `toRecord` to resolve and map `repoId: RepositoryId(row.repo_id ?? 'unknown')`.
- Updated all existing unit tests in `packages/infrastructure/src/sqlite/__tests__/run-repository.test.ts` to supply `repoId`.
- Added unit tests verifying active run conflict constraint is repo-scoped (uniqueness on same repo conflicts, but allowed across different repositories).
- Added unit tests verifying query filters (`findByIssueNumber` and `updateStatusByIssueNumber`) enforce strict repository boundaries.

## Files Modified/Created
- `packages/infrastructure/src/sqlite/migrations/0016-add-repo-id-to-runs.ts` (Created)
- `packages/infrastructure/src/sqlite/migrations.ts` (Modified)
- `packages/infrastructure/src/sqlite/run-repository.ts` (Modified)
- `packages/infrastructure/src/sqlite/__tests__/run-repository.test.ts` (Modified)
- `implementation-log.md` (Modified)

## Verification Results
- RunRepository tests: `pnpm vitest run packages/infrastructure/src/sqlite/__tests__/run-repository.test.ts -t "RunRepository"`: 18/18 tests passed.
- Compile packages/infrastructure: `pnpm exec tsc -p packages/infrastructure/tsconfig.json --noEmit`: Completed successfully with no errors.
