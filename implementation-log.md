# Implementation Log - Task 12: CLI run commands updates

## Summary
The `--repository-id` flag was already present on CLI commands (`start`, `cancel`, `resume`, `retry`, `check-merge-readiness`, `execute`) and the resolution logic (`resolveCliRepoId` and `resolveRepoIdForCli`) was already implemented in `apps/api/src/cli.ts` according to the step requirements.

However, the CLI test suite in `apps/api/src/__tests__/cli.test.ts` had several failing and hanging tests:
1. `cancel routes through loadRepositoryForRun` was failing with a `SqliteError: NOT NULL constraint failed: runs.display_id`.
2. `start works without --repository-id when exactly one repo enabled` was timing out.
3. `start with --repository-id owner/name resolves via inspectRepository` was timing out.

## Fixes Implemented
- In `apps/api/src/__tests__/cli.test.ts`:
  - Updated `mockRun` in the cancel test to be a fully typed and compliant `Run` object containing the required properties `displayId`, `type`, and `skippedPhases` to prevent SQLite constraint failures.
  - Fixed `process.stdout.write` mock implementations in the start tests. The original mock was a simple stub (`() => true`) that did not invoke the callback passed to it. In `cli.ts`, writing command output awaits the completion callback of `process.stdout.write`, causing the command action promise to hang indefinitely. Updated the mock to correctly invoke the callback argument when present.

## Verification
- Verified all the specific repository-id flag test cases pass successfully.
- Ran pre-PR checks:
  - `pnpm -r build` - PASS
  - `pnpm -r typecheck` - PASS
  - `pnpm lint` - PASS
  - `pnpm -r test` (full test suite) - PASS
