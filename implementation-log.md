# Implementation Log

## Task 4: apps/api/src/worker-drain-loop.ts — persistent worker-drain loop

### What was implemented:
- Modified `JobQueuePort` in `packages/application/src/ports/job-queue-port.ts` to add `listActive(): Job[]`.
- Implemented `listActive(): Job[]` in `FakeJobQueuePort` under `packages/application/src/test-doubles/fake-job-queue-port.ts`.
- Implemented `listActive(): Job[]` in SQLite `JobQueueRepository` under `packages/infrastructure/src/sqlite/job-queue-repository.ts`.
- Created `apps/api/src/worker-drain-loop.ts` featuring:
  - `startWorkerDrainLoop`: sets up a recurring interval with a concurrency guard (`isRunning`) preventing overlapping runs.
  - `buildRecoverableRunIds`: retrieves active runs and filters out those matching currently active jobs or runs with active worker leases, resolving potential split-brain recovery conflicts.
  - Uses `deps.now()` as the exact cutoff for reclaiming stale claims to prevent double recovery delays.
- Created unit tests under `apps/api/src/__tests__/worker-drain-loop.test.ts`.

### Verification results:
- Ran `pnpm --filter @ai-sdlc/api test -- worker-drain-loop.test.ts` successfully (all 3 tests passing).
- Verified `pnpm -r typecheck`, `pnpm depcruise`, `pnpm -r test`, and `pnpm lint` all passed successfully.
