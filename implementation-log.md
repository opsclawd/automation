# Task 6 Implementation Log - Extend StartIssueRun use case

## What was implemented:
- Added `repositoryPort` dependency to `StartIssueRunDeps` with `findById` and `listEnabled` methods.
- Made `repoId` optional in `StartIssueRunInput` and added it to `StartIssueRunOutput`.
- Extended `StartIssueRun` execution logic to resolve the `repoId`:
  - Uses explicit `repoId` if supplied.
  - Defaults to the single enabled repository if omitted.
  - Throws `RepositoryValidationError` if there are multiple enabled repositories and no explicit `repoId` is provided.
- Approved the repository by registry state:
  - Throws `RepositoryNotApprovedError` if the repository is not found, disabled, degraded, or unreachable.
- Replaced the hardcoded `runsDir` heuristic for finding the repository root (`this.deps.runsDir.replace(/\/\.ai-runs$/, '')`) with `repo.localBasePath` directly from the repository registry.
- Updated the worktree root path calculation to use this resolved repository base path.
- Updated all return statements in `StartIssueRun` to include the resolved `repoId`.
- Maintained backwards compatibility with existing tests by providing a default fallback `repositoryPort` that matches the legacy behavior.

## Verification results:
- Wrote failing unit tests matching the exact specification requirements.
- Verified test suite passes successfully: `pnpm vitest run packages/application/src/__tests__/start-issue-run.test.ts` passes all 32 tests.
- Verified project builds successfully: `pnpm -r build` passes.
- Verified types are correct: `pnpm -r typecheck` passes.
- Verified linter rules: `pnpm lint` passes with 0 warnings/errors.
- Verified full test suite: `pnpm -r test` passes.
