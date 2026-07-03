# Implementation Log — Task 5 (Worker scheduler cleanup)

Branch: `ai/issue-589`
Date: 2026-07-02
Scope: Task 5 only — `apps/api/src/worker-scheduler.ts` + `apps/api/src/cli.ts` call-site update.

## Files modified

- `apps/api/src/worker-scheduler.ts` — full rewrite per plan steps 5.1 and 5.2.
- `apps/api/src/cli.ts:356` — drop redundant `c.jobQueue` argument per plan step 5.3.

## Scope exception: one-line addition to `packages/application/src/executor/worker-loop.ts`

The Task 5 spec mandates this exact expression in the new `runUntilComplete`:

```ts
const deps: WorkerLoopDeps = { ...this.baseDeps, recoverableRunIds, outerSignal: signal };
```

…with the expected outcome "typecheck passes" (Step 5.4). However
`outerSignal` is not yet declared on `WorkerLoopDeps` (that is part of
Task 6 step 6.1). Adding the field now is the minimum pre-staging
required for Step 5.4's stated expectation. The change is a single
optional declaration:

```ts
outerSignal?: AbortSignal;
```

It is backwards-compatible (optional field), Task 6's `workerLoop`
catch-block can now be added in the next run without further TS churn.

This is the smallest possible scope deviation and is documented here
so the operator can audit. The rest of `worker-loop.ts` (the catch
block distinguishing abort vs fail) is deliberately untouched — it
remains Task 6's work.

## Steps executed

- **Step 5.1** — Removed `export type WorkerLoopBaseDeps = …` from
  `worker-scheduler.ts:5`. Replaced the constructor (was 36-42) with the
  spec's three-argument form: `(workerIds, baseDeps, tickIntervalMs = 2_000)`.
  Added `import type { Job } from '@ai-sdlc/domain'` at top of file.
- **Step 5.2** — Replaced `isTerminal(status: string)` with the spec's
  tight union form: `isTerminal(status: Job['status'])`. Rewrote
  `runUntilComplete` per the spec text: pre-tick `reclaimStaleClaims`
  call, `outerSignal: signal` plumbing, per-worker `Promise.race`
  timeout with abort-signal-driven rejection (12s at default 2s tick),
  `Error`-instance normalization on throw site, and post-tick
  signal-aborted cleanup branch (releaseClaim if `claimed`,
  markCancelled if `running`).
- **Step 5.3** — Removed the third constructor argument at
  `apps/api/src/cli.ts:356`. The call site now reads
  `new WorkerScheduler([workerId], c.workerLoopDeps)`.
- **Step 5.4** — Ran `pnpm -r typecheck` (PASS) and
  `pnpm -C apps/api test -- worker-scheduler.test.ts`. The test file
  fails on 4 tests as the plan expects; Task 11's fixture rewrite is
  the canonical fix.

## Verification results

- `pnpm -r typecheck` → PASS.
- `pnpm depcruise` → 0 errors, 31 pre-existing `.next/` build-artifact
  warnings (unrelated).
- `pnpm lint` → PASS.
- `pnpm -C apps/api test -- worker-scheduler.test.ts` → 3 passed, 4
  failed. Failures are all `TypeError: this.baseDeps.queue.reclaimStaleClaims
  is not a function` — the test fixture's `JobQueuePort` mock predates
  Task 3's port extension. Per plan this is fixed in Task 11/12.
- `pnpm -r test` → only the 3 migration-count tests (migration count
  is 18 since Task 1 landed, fixture asserts 17) fail; Task 18 will
  derive the count from the registry. Worker-scheduler test fails
  described above.

## Self-review

- **Scope:** `git diff --stat HEAD~1` (commit-level review pending)
  covers `cli.ts`, `worker-scheduler.ts`, and the one-line
  `worker-loop.ts` scope exception documented above. No later-task
  work has been pre-staged.
- **Behavior parity:** The constructor signature change is the only
  call-site-relevant surface change. Tests that pass the old
  4-argument form will not compile; the only call site is updated.
- **P1-3 / D2:** Per-tick `reclaimStaleClaims` sweep implemented with
  a cutoff of `now - tickIntervalMs * 6` (12s at default tick).
- **P1-5 / D1:** Per-worker `Promise.race` with abort-signal-driven
  rejection. Timeout 12s at default tick.
- **P2-7 / D4 scaffolding:** `outerSignal` is plumbed through to
  `workerLoop`'s `deps`. The catch-block to *consume* `outerSignal` is
  Task 6.
- **P2-3 / D7:** Redundant queue parameter removed; `cli.ts:356`
  updated.
- **P2-9:** Dead `WorkerLoopBaseDeps` export removed.
- **P3 non-Error normalization:** Done at the `throw` site.
- **P3 `isTerminal` exhaustiveness:** Tightened to `Job['status']`.

## Concerns

- The fixture/test fix is owned by Task 11. Without it the existing
  tests fail at runtime even though the implementation is correct.
- The `outerSignal` field declaration was added in
  `worker-loop.ts` (one line). If the operator prefers strict separation
  between tasks, this single line can be reverted and the
  `outerSignal: signal` line in `worker-scheduler.ts` will fail
  typecheck until Task 6 lands.
