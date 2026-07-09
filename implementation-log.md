# Implementation Log - Task 3

## Wire ReapOrphanedTestWorkers into composeRoot() startup sweeps

### What was implemented:
- Imported `ReapOrphanedTestWorkers` from `@ai-sdlc/application` and `listProcesses`, `killProcess` from `@ai-sdlc/infrastructure` in `apps/api/src/compose.ts`.
- Extended the `Container` interface to include `reapOrphanedTestWorkers`.
- Instantiated `ReapOrphanedTestWorkers` inside `composeRoot`.
- Added the reap execution block inside the startup sweeps check in `composeRoot`.
- Exposed `reapOrphanedTestWorkers` in the returned `Container` object.

### Verification results:
- Typechecked `apps/api` with `pnpm --filter @ai-sdlc/api typecheck` successfully.
- Ran existing compose-level tests successfully.
- Verified layer boundaries with `pnpm depcruise` successfully.
- Verified lint compliance with `pnpm lint` successfully.
