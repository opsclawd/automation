# PR Review Comment Address findings

The PR review comment asked to keep unexpired leases exclusive across same-worker reacquires unless the existing lease is for the same run. 

## What Worked
1. Modified `packages/infrastructure/src/sqlite/worker-lease-repository.ts` to update the SQL query to only allow lease reacquisition if it matches the same run and worker.
2. Modified the in-memory fake `packages/application/src/test-doubles/fake-worker-lease-port.ts` to implement the same logic.
3. Reverted the test case `permits re-acquisition of a lease if requested by the same worker currently holding it` back to the original conflict test case `does not release a pre-existing lease held by the same worker on acquire conflict` in `packages/application/src/executor/__tests__/worker-loop.test.ts`.

## Learnings
Ensure that lease re-entrancy logic requires exact run matches, as otherwise same-worker sweeps could accidentally override existing leases active on other runs.
