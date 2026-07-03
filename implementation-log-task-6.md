# Implementation Log — Task 6 (workerLoop outer-signal abort distinction)

Branch: `ai/issue-589`
Date: 2026-07-02
Scope: Task 6 only — `packages/application/src/executor/worker-loop.ts` catch block.

## What was already in place from Task 5

Task 5 (commit `25688b9c`) pre-staged `outerSignal?: AbortSignal;` on
`WorkerLoopDeps` with an explicit scope note saying the workerLoop
catch-block consumption belongs to Task 6. So Step 6.1 was already
complete on entry to this run and required no further action.

## Files modified

- `packages/application/src/executor/worker-loop.ts` — catch block now
  distinguishes abort vs fail: if the run had `started` AND
  `deps.outerSignal?.aborted`, the job is `markCancelled` (wrapped in
  try/catch for the "already terminal" race); otherwise the existing
  `markFailed` path runs. The pre-start `releaseClaim` branch is
  unchanged.

## Verification

- `pnpm -C packages/application test -- executor` — 52/52 pass
  (4 test files, including the 15 worker-loop tests covering heartbeat
  failure during prepareWorktree / executeRun / grace / never-settles).
  The new `outerSignal` is optional, so existing tests that omit it
  follow the `markFailed` branch — verified by the unchanged
  `heartbeat failure during executeRun fails the job immediately`
  test, which asserts the job ends up failed (not cancelled) when no
  outer abort is set.
- `pnpm -C packages/application typecheck` — PASS.

## Scope check

`git diff --stat HEAD`:
```
 packages/application/src/executor/worker-loop.ts | 10 +++++++++-
 1 file changed, 9 insertions(+), 1 deletion(-)
```

Only one file touched, only the catch-block diff specified in Step
6.2. No work pre-staged for Tasks 7+.