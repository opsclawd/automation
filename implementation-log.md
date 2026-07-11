# Implementation Log - Task 13: Update Quickstart docs

## Summary
Updated `docs/quickstart.md` with migration notes detailing the introduction of the stable `repositoryId` field backfilled under migration 0025, and the new requirement for `POST /api/runs` to include `repositoryId` when more than one repository is enabled.

## Changes
- Appended a new `## Migration` section to `docs/quickstart.md` containing the migration note.

## Verification
- Verified build: `pnpm -r build` (PASS)
- Verified typechecking: `pnpm -r typecheck` (PASS)
- Verified linting: `pnpm lint` (PASS)
- Verified test suite: `pnpm -r test` (PASS)
