# Task 6 Implementation Summary

Implemented the periodic sweep timer and persistent worker drain loop for the `serve` command.

## What was implemented
1. Exposed `deregister(id: WorkerId): void` on `WorkerRegistryPort` and implemented it in both `FakeWorkerRegistryPort` and `WorkerRegistryRepository`.
2. Modified the CLI's `serve` command to disable the legacy automatic startup sweeps by setting `runStartupSweeps: false` in `composeRoot`.
3. Wired worker registration, heartbeat, and the drain loop to start in the `serve` command action logic when `workerRegistry` and `workerLoopDeps` are present.
4. Set up an initial single reactivation sweep to run at startup, followed by starting the periodic sweep timer in its `.finally` callback (clamped to a minimum of 30 seconds).
5. Configured the `shutdown` handler to stop the drain loop and sweep timer, deregister the serve worker, and stop `testWorkerReaper`.

## Tests
- Created `apps/api/src/__tests__/cli-serve-sweep-wiring.test.ts` to verify the gating logic and that the sweeper executes correctly on interval.
- Ran the full test suite in `apps/api` to verify everything is green.
