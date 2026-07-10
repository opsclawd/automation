# Implementation Log - Task 5

## Status
DONE

## What was implemented
- Hoisted config loading and `readyMaxDays` calculation inside `composeRoot` in [compose.ts](file:///home/gary/.openclaw/workspace/automation/.ai-worktrees/issue-681/apps/api/src/compose.ts) to run unconditionally.
- Lazily instantiated `GhCliAdapter` via `getGhAdapterForSweep()`.
- Exposed `serveSweepIntervalSeconds: number` and `buildWaitingRunsSweeper` factory function on the `Container` interface and returned them from `composeRoot`.
- Implemented `buildWaitingRunsSweeper` factory inside `composeRoot` injecting dependencies such as `runRepository`, `workerLeaseRepository`, `jobQueue`, and `eventBus`, with a custom `applyReactivation` function that correctly identifies finalization transitions versus genuine reactivations to defer or apply updates.
- Added failing tests to [compose-sweep-waiting.test.ts](file:///home/gary/.openclaw/workspace/automation/.ai-worktrees/issue-681/apps/api/src/__tests__/compose-sweep-waiting.test.ts) to verify correct default behavior of the interval and the factory function, and ensured all tests pass.
