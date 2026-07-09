# Implementation Log - Task 4

## Wire ReapOrphanedTestWorkers periodic reap loop in serve mode

### What was implemented:
- Imported `ReapOrphanedTestWorkers` from `@ai-sdlc/application` in `apps/api/src/cli.ts`.
- Added the `startTestWorkerReaper` helper function in `apps/api/src/cli.ts` to manage the periodic `setInterval` loop (defaulting to 5 minutes) and log reaped processes.
- Wired `startTestWorkerReaper` into the `serve` command action to run after the server starts, and stopped it gracefully during the `shutdown` handler.

### Verification results:
- Verified that `startTestWorkerReaper` and its stop method are present and correctly wired.
- Verified that the `apps/api` package typechecks clean with `pnpm --filter @ai-sdlc/api typecheck`.
- Ran the full test suite with `pnpm -r test` successfully.
- Verified layer boundaries with `pnpm depcruise` successfully.
