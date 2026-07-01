# Task 6 Implementation Log

## Status
DONE

## What Was Implemented
- Updated `installSignalHandlers()` in `apps/api/src/cli.ts` to accept `repoId` and scope its `findByIssueNumber()` and `updateStatusByIssueNumber()` queries to the repository of the run.
- Updated all `installSignalHandlers()` callers in `apps/api/src/cli.ts` (the TS executor run path, execute command path, and resume command path) to pass the appropriate `repoId` for the run being protected.
- Required `c.repoFullName` in the Bash executor run path before invoking `StartIssueRun.execute()`, resolving `repoId: RepositoryId(c.repoFullName)` and passing it to both `installSignalHandlers()` and `StartIssueRun.execute()`.
- Updated `runs cancel --issue` in `apps/api/src/cli.ts` to resolve `RepositoryId(c.repoFullName)` before issue lookup and call `findByIssueNumber(repoId, issueNumber)`.
- Verified that `compose.ts` does not pass `findRepoId` to `new ResumeRun(...)` (already removed in Task 4).
- Updated integration/API test databases in `cli.test.ts` and `runs-recovery-routes.test.ts` to seed runs with `repo_id` (so repository lookups and signal handlers locate them properly).
- Updated `compose.test.ts` to pass `repoId: RepositoryId('owner/repo')` to all `c.startIssueRun.execute()` calls.

## Files Modified
- `apps/api/src/cli.ts`
- `apps/api/src/__tests__/cli.test.ts`
- `apps/api/src/__tests__/runs-recovery-routes.test.ts`
- `apps/api/src/__tests__/compose.test.ts`
- `implementation-log.md`

## Verification Results
- All 49 CLI tests passed: `pnpm vitest run apps/api/src/__tests__/cli.test.ts`
- All 5 CLI runs resume confirmation tests passed: `pnpm vitest run apps/api/src/__tests__/cli-runs-resume-confirmation.test.ts`
- All 12 recovery routes tests passed: `pnpm vitest run apps/api/src/__tests__/runs-recovery-routes.test.ts`
- All 41 compose tests passed: `pnpm vitest run apps/api/src/__tests__/compose.test.ts -t "composeRoot"`
- API typescript compiler output: `pnpm exec tsc -p apps/api/tsconfig.json --noEmit` completed successfully with 0 errors.
- Linter verification: `pnpm lint` passed with no warnings or errors.
- Layer boundaries verification: `pnpm depcruise` completed with 0 errors.
