# Task 9 — phases:[] regression fix + atomic reconcile

## Scope
Two edits to `apps/api/src/cli.ts` only.

## Changes

### Step 9.1 — Populate phases from the repository
Replaced the hard-coded `phases: []` in the final stdout payload with a real
`c.phaseRepository.listByRun(run.uuid)` lookup. Also added `jobId` and
`workerId` to the payload (matches the format Task 9 specifies in the
patch, which is consistent with the other stdout consumers that already
log these identifiers).

### Step 9.2 — Atomic reconcile for stale 'running' runs
The existing reconcile block called `c.runRepository.update(...)` which
would unconditionally clobber the row, racing against a concurrent cancel
webhook that may have already written `status: 'cancelled'`. Replaced
with `c.runRepository.atomicUpdateByUuid(..., 'running')` so the update
is a no-op unless the run is still actually 'running'.

## Verification
- `pnpm -C apps/api test -- cli.test.ts` → 47/47 PASS
- `pnpm -C apps/api typecheck` → clean
- `pnpm depcruise` → 0 errors (only pre-existing `.next` orphan warnings)

## Files changed
- `apps/api/src/cli.ts`