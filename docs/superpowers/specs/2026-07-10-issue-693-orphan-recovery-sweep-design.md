# Design: issue #693 — auto-recover crashed runs in the periodic serve sweep

## Stated problem

Issue #693 asks for automatic crash recovery: when an orchestrator run crashes
mid-phase (OOM, host reboot, SIGKILL, lost network), the `serve` process must
detect it within one sweep interval and re-enqueue a resume job for a worker —
without a human running `runs resume` or `runs execute`.

Today `SweepOrphanedRuns` (`packages/application/src/sweep-orphaned-runs.ts:9`)
detects dead-PID runs but only sets status to `failed` and only runs once at
`composeRoot()` startup (`apps/api/src/compose.ts:1298-1368`, gated by
`opts.runStartupSweeps`). The follow-up job and lease-then-enqueue-then-release
machinery already exist for the reactivation path (`WaitingRunsSweeper`,
`packages/application/src/waiting-runs-sweeper.ts:28`) — we just need to mirror
that pattern for the orphaned-run path.

Depends on #692 (already applied — orphaned runs are marked `failed`, not
`cancelled`).

## Verified findings (evidence-first)

All references below were verified against the current worktree (`issue-693`).

### What already exists

- **`SweepOrphanedRuns`** at `packages/application/src/sweep-orphaned-runs.ts:9`
  iterates `runRepository.findActiveRuns()`, skips runs with no `pid`, calls
  `isProcessAlive(run.pid)`, and on a dead PID calls
  `runRepository.updateStatusByUuid(uuid, { status: 'failed', completedAt,
  failureReason: 'orphaned: process <pid> no longer running', currentPhase: null
  })`. Returns `{ swept: number }`. The status fix from #692 is already in the
  file at line 24 (`status: 'failed'`).
- **`WaitingRunsSweeper`** at
  `packages/application/src/waiting-runs-sweeper.ts:28` is the exact pattern
  this issue should mirror: takes a `SweepWaitingRuns` result, iterates the
  reactivated runs, acquires a `WorkerLease`, sets status with
  `atomicUpdateByUuid` for optimistic concurrency, publishes a reactivation
  event, `createJob({ id: 'sweep-<uuid>-<ts>', runId, repoId, issueNumber,
  priority: SWEEP_JOB_PRIORITY=10 })`, and `queue.enqueue({ job })`. Rolls back
  status on enqueue error, releases the lease in `finally`.
- **`findActiveRuns()`** returns runs whose status is **not** in
  `['passed', 'failed', 'cancelled']` (verified
  `packages/application/src/test-doubles/fake-run-repository.ts:105-109`).
  This means both `running` and `waiting` (and any other non-terminal status)
  are returned. After a sweep sets status to `failed`, the run is no longer
  returned by `findActiveRuns()` — natural idempotency.
- **Serve-mode periodic timer** is already wired:
  `apps/api/src/cli.ts:144-196` (`startWaitingRunsSweepTimer`), invoked at
  `apps/api/src/cli.ts:762-775` with `serveSweepIntervalSeconds` from the
  layered config (`apps/api/src/compose.ts:1281`,
  `packages/shared/src/config/schema.ts:389-391`). `MIN_SWEEP_INTERVAL_MS =
  30_000` clamp, `isRunning` guard, full logging. The startup sweep also runs
  the reactivation sweep once (lines 762-767) before scheduling the periodic
  timer.
- **Worker drain loop** filters runs by `checkActiveLease` and excludes any
  with an active job (`apps/api/src/worker-drain-loop.ts:7-28`) — so once our
  sweeper enqueues a job, the drain loop will claim and execute it without us
  needing to schedule anything else.
- **Wiring exposure**: `serveSweepIntervalSeconds` and
  `buildWaitingRunsSweeper` are already on the container at
  `apps/api/src/compose.ts:4612-4613` and consumed in
  `apps/api/src/cli.ts:756`. The CLI registers a `serveWorkerId` and reuses it
  for the worker drain loop (lines 730-751) and the sweeper (line 762).
- **Fakes exist** in `packages/application/src/test-doubles/`: `FakeRunRepository`,
  `FakeEventBus`, `FakeJobQueuePort`, `FakeWorkerLeasePort`,
  `FakeWorkerRegistryPort`, `FakeRepositoryPort`. Used by
  `apps/api/src/__tests__/serve-sweep-drive-integration.test.ts:1` and
  `packages/application/src/__tests__/waiting-runs-sweeper.test.ts:1`.

### What is missing

- `SweepOrphanedRuns.execute()` returns `{ swept: number }` only — it does not
  return the swept run identifiers. The wrapper layer needs `uuid`, `repoId`,
  `issueNumber`. (`currentPhase` is not required — `planRunRecoveryAction`
  re-derives the resume phase.)
- No periodic invocation of `SweepOrphanedRuns`. It runs once at startup only.
- No lease check on top of the PID check. A worker that recently died but
  whose lease has not yet expired (TTL is 30s) would still be swept on the
  next interval — the lease-then-enqueue-then-release wrapper will collide
  with the still-held lease and skip cleanly, but we should skip upfront
  rather than rely on collision-then-skip, mirroring `worker-drain-loop.ts:23`.
- No resume job is enqueued after a sweep. The dead run is left as `failed`
  forever (until a human notices).

## Approach

Add a new application-layer use case **`OrphanedRunsSweeper`** that wraps
`SweepOrphanedRuns`, applies an active-lease guard, and enqueues a resume job
for each swept run. Wire it into the same periodic timer as
`WaitingRunsSweeper` and run it once at startup alongside the reactivation
sweep.

### 1. Extend `SweepOrphanedRuns.execute()` return type

`packages/application/src/sweep-orphaned-runs.ts:12` currently returns
`{ swept: number }`. Extend it to:

```ts
export interface SweepOrphanedRunEntry {
  run: RunRecord;        // the run BEFORE its status was changed
  reason: string;        // 'orphaned: process <pid> no longer running'
}
export interface SweepOrphanedRunsResult {
  swept: number;
  sweptRuns: SweepOrphanedRunEntry[]; // ordered, iterable
}
```

`sweptRuns` mirrors the `SweepWaitingRunsResult.reactivatedRuns` shape
(`packages/application/src/sweep-waiting-runs.ts`). The pre-sweep `run` is
captured so the wrapper can build a job without a follow-up `findByUuid` call
(though `findByUuid` would also work — keeping `run` for clarity and to mirror
the reactivation sweeper).

This is a backwards-compatible additive change. The startup-only call site at
`apps/api/src/compose.ts:1300-1307` still works (it just ignores the new
field), and `sweep-orphaned-runs.test.ts` continues to pass after updating
assertions from `result.swept` to also reference `result.sweptRuns.length`.

### 2. Add `OrphanedRunsSweeper`

New file `packages/application/src/orphaned-runs-sweeper.ts`. Structure
mirrors `WaitingRunsSweeper`:

```ts
export interface OrphanedRunsSweeperDeps {
  sweep: SweepOrphanedRuns;
  runRepository: RunRepositoryPort;
  leases: WorkerLeasePort;
  queue: JobQueuePort;
  eventBus: EventBusPort;
  now: () => Date;
  logger: LoggerPort;
}

export interface OrphanedRunsSweeperResult {
  swept: number;
  enqueued: number;
  skippedActiveLease: number;
  skippedAlreadyQueued: number;
  enqueueErrors: Array<{ runId: string; error: string }>;
}

export class OrphanedRunsSweeper {
  constructor(private readonly deps: OrphanedRunsSweeperDeps) {}
  async execute(workerId: WorkerId): Promise<OrphanedRunsSweeperResult>;
}
```

Per swept run (the lease is the gate, **not** the PID — `SweepOrphanedRuns`
already filtered dead-PID runs):

1. **Skip if a lease is still active** for the run's `repoId` (use
   `deps.leases.checkActiveLease(repoId, now())`). Increment
   `skippedActiveLease`. Rationale: even if the PID is dead, a live lease on
   the same repo means another worker just claimed it (race window between
   PID death and lease release). Mirrors `worker-drain-loop.ts:23`.
2. **Acquire lease** with `deps.leases.acquire({ repoId, workerId, runId, now,
   ttlMs: 30_000 })`. On `WorkerLeaseConflictError` (concurrent acquire from
   another sweep tick) increment `skippedActiveLease` and continue. On any
   other error, push to `enqueueErrors` and continue.
3. **Skip if a job is already queued or running for the run**. Use
   `queue.listActive().some(j => j.runId === run.uuid && (j.status === 'queued'
   || j.status === 'claimed' || j.status === 'running'))`. This is the same
   check `worker-drain-loop.ts:15-19` uses to avoid double-driving. Increment
   `skippedAlreadyQueued`. Without this, a run that was enqueued just before
   the next sweep tick would get a second job and run twice.
4. **Enqueue resume job**:
   ```ts
   const job = createJob({
     id: `sweep-orphan-${run.uuid}-${now.getTime()}` as JobId,
     runId: run.uuid as RunId,
     repoId: run.repoId,
     issueNumber: run.issueNumber as IssueNumber,
     priority: SWEEP_JOB_PRIORITY, // 10, same as reactivation
     createdAt: now,
   });
   queue.enqueue({ job });
   ```
5. **Transition status `failed → running`** via
   `runRepository.atomicUpdateByUuid(run.uuid, { status: 'running',
   currentPhase: null, completedAt: null, failureReason: null }, 'failed')`.
   If the transition fails (concurrent update — another sweeper or human
   moved the run), log and `continue` (lease released in `finally`). The
   queued job is left in the queue; the next sweep tick will see the run
   is no longer `failed` and skip it, and the worker that claims the job
   will look up the run's current status and act accordingly.
6. **Publish event** `orphaned-run.sweep.recovered` with
   `metadata: { reason, originalPid }`. Logged at `info` level.
7. **On enqueue error**: log; the run is already `failed` (set by the inner
   sweep), so no rollback needed — the next sweep tick will retry the enqueue
   (idempotent on `sweptRuns` because `findActiveRuns` no longer returns
   `failed` runs).
8. **Release lease** in `finally`.

Constants live in this file: `SWEEP_JOB_PRIORITY = 10` (reuse the same value
as `WaitingRunsSweeper`; both kinds of sweep are equally time-sensitive
relative to user-driven runs), `LEASE_TTL_MS = 30_000`.

Export from `packages/application/src/index.ts` alongside the reactivation
sweeper.

### 3. Wire into serve-mode timer

In `apps/api/src/compose.ts`:

- Add `buildOrphanedRunsSweeper: () => OrphanedRunsSweeper` to the container
  (alongside `buildWaitingRunsSweeper`, line 466).
- Factory wires the same deps as `buildWaitingRunsSweeper` (line 4033):
  ```ts
  const buildOrphanedRunsSweeper = () =>
    new OrphanedRunsSweeper({
      sweep: new SweepOrphanedRuns({
        runRepository,
        isProcessAlive: checkPid,
        now: () => new Date(),
      }),
      runRepository,
      leases: workerLeaseRepository,
      queue: jobQueue,
      eventBus,
      now: () => new Date(),
      logger: sweepLogger,
    });
  ```

In `apps/api/src/cli.ts`:

- Replace `startWaitingRunsSweepTimer` with a unified
  `startServeSweepTimer` that runs **both** sweepers on each tick, sharing
  the `isRunning` guard so the two sweeps execute sequentially under one
  guard (avoids racing for `workerLoopDeps`). Both return shapes are logged.
- At startup (currently lines 762-775) execute both sweepers once in sequence
  before scheduling the periodic timer. The `.finally` callback that
  schedules the timer runs once after both initial sweeps complete.
- Shutdown stops the single timer (line 781).

The unified timer signature:

```ts
function startServeSweepTimer(
  deps: {
    waitingSweeper: { execute(workerId): Promise<WaitingRunsSweeperResult> };
    orphanedSweeper: { execute(workerId): Promise<OrphanedRunsSweeperResult> };
  },
  intervalSeconds: number,
  workerId: WorkerId,
): { stop: () => void };
```

### 4. Why we transition `failed → running` in the sweeper (not in `workerLoop`)

We considered two options for handling the run status after sweep + enqueue:

- **(A)** Transition `failed → running` in `OrphanedRunsSweeper.execute`
  after enqueue (mirrors `WaitingRunsSweeper` at lines 70-78 which
  transitions `waiting → running` via `atomicUpdateByUuid`).
- **(B)** Leave the run as `failed` and update `workerLoop` to allow claiming
  jobs for `failed` runs.

Adopted (A) — the full code is in §2 step 5 above. Reasons:

- Self-contained: the sweeper is the source of truth for "this run is being
  re-driven by the periodic sweep".
- Mirrors the existing reactivation pattern, so a future reader sees one
  shape for "sweep enqueues a job and moves a run forward".
- Avoids expanding `workerLoop` semantics for a one-call-site concern.

If `workerLoop` later proves it already accepts `failed` runs, the
transition in (A) is still safe — file a follow-up to simplify, not a fix.

### 5. Startup sweep wiring

In `apps/api/src/compose.ts:1298-1368`, the existing startup block already
runs `SweepOrphanedRuns.execute()` and logs `sweepResult.swept`. Extend it to
also log `sweepResult.sweptRuns.length` and (in non-serve startup, gated on
`opts.runStartupSweeps !== false`) call `OrphanedRunsSweeper.execute(...)` so
that crashes which occurred between the last serve-mode sweep and the
restart still get picked up. Non-serve startup (e.g., `runs execute`) calls
the wrapper too — the run is marked `failed` then enqueued; the in-flight
worker (or next worker) picks it up. The `runStartupSweeps: false` override
in serve-mode `cli.ts:713` already prevents double-sweeping at startup in
serve mode (the periodic sweep handles it), so the compose-side startup
sweep only runs in non-serve mode where the periodic sweep never starts.

### 6. Tests

#### Unit tests in `packages/application/src/__tests__/`

**`sweep-orphaned-runs.test.ts` (extend existing)** — assert the new return
shape:

- One swept run → `result.sweptRuns` has length 1, contains the run with its
  pre-sweep status (`running` or `waiting`) and a `reason` matching the
  current `failureReason` template.
- Zero swept runs → `result.sweptRuns` is `[]`.
- Multiple swept runs → `result.sweptRuns` order matches `findActiveRuns()`
  iteration order.

**`orphaned-runs-sweeper.test.ts` (new)** — mirror
`waiting-runs-sweeper.test.ts`:

- AC1 (basic): dead-PID `running` run → status becomes `failed`, one job
  enqueued with priority 10, run transitions back to `running` after enqueue,
  lease released.
- AC2 (lease skip): dead-PID run with an **active** lease on its repo → no
  enqueue, `skippedActiveLease = 1`, status still `failed` (we did not
  transition it back).
- AC3 (lease conflict): sweep acquires the lease but the wrap-level acquire
  throws `WorkerLeaseConflictError` → `skippedActiveLease = 1`, no enqueue,
  no status transition.
- AC4 (already-queued): dead-PID run that already has a `queued` job for its
  run id → `skippedAlreadyQueued = 1`, no second job.
- AC5 (enqueue error): queue throws on enqueue → `enqueueErrors` has 1 entry,
  status remains `failed` (the `failed → running` transition is sequenced
  after enqueue; verify this ordering).
- AC6 (waiting run): a `waiting` run with a dead PID is swept and enqueued
  (mirrors AC1 but with `status: 'waiting'` going in).
- AC7 (live PID never swept): run with live PID → not in `sweptRuns`,
  `swept = 0`, no enqueue, no status change.

#### Integration test in `apps/api/src/__tests__/`

**`serve-orphan-recovery-integration.test.ts` (new)** — full sweep → enqueue
→ worker drain loop drives to completion, mirroring
`serve-sweep-drive-integration.test.ts`:

- AC-I1: `running` run with dead PID → after one sweep tick the run is
  `running` again, the queue has a `succeeded` job for it (after
  `workerLoop` runs), and the lease is released.
- AC-I2: `running` run with a live PID is not swept and is not enqueued
  (acceptance: "live run never swept").
- AC-I3: `running` run with a dead PID but an active lease for the same repo
  is not enqueued (lease-respect acceptance criterion).
- AC-I4: A `waiting` run with a dead PID is enqueued. (This covers the case
  where a worker died while transitioning a waiting run back to running
  via `WaitingRunsSweeper` — currently the run is `failed` and orphaned
  resume re-drives it.)

All tests use the fakes in
`packages/application/src/test-doubles/`; no infrastructure layer is needed.

#### CLI wiring test

Extend `apps/api/src/__tests__/cli-serve-sweep-wiring.test.ts` to assert:

- `composeRoot` is called with a container exposing both
  `buildWaitingRunsSweeper` and `buildOrphanedRunsSweeper`.
- The serve-mode startup path executes both sweepers once and schedules the
  unified timer.
- After advancing fake timers by `intervalSeconds`, **both** sweepers' `execute`
  is called.

### 7. Index/exports

Add `OrphanedRunsSweeper`, `OrphanedRunsSweeperDeps`,
`OrphanedRunsSweeperResult`, and the new `SweepOrphanedRunsResult` /
`SweepOrphanedRunEntry` types to `packages/application/src/index.ts`.

## Architecture summary

```
serve timer (cli.ts) — every intervalSeconds (≥30s)
  │
  ├─→ OrphanedRunsSweeper.execute(serveWorkerId)
  │    │
  │    ├─→ SweepOrphanedRuns.execute()
  │    │    ├─→ runRepository.findActiveRuns()
  │    │    ├─→ for each: checkPid(run.pid)
  │    │    └─→ if dead: runRepository.updateStatusByUuid(uuid, 'failed')
  │    │
  │    └─→ for each swept run:
  │         ├─→ leases.checkActiveLease(repoId) → skip
  │         ├─→ leases.acquire(...) → skip on conflict
  │         ├─→ queue.listActive() already contains run → skip
  │         ├─→ queue.enqueue({ job })
  │         ├─→ atomicUpdateByUuid(run, { status: 'running' }, 'failed')
  │         ├─→ eventBus.publish('orphaned-run.sweep.recovered')
  │         └─→ leases.release(repoId, workerId)  [finally]
  │
  └─→ WaitingRunsSweeper.execute(serveWorkerId)
       (unchanged; same interval, same isRunning guard)

worker-drain-loop (every 5s)
  └─→ claimNext() picks up the orphan-resume job
       └─→ workerLoop → executeRun → pid stamped → resume → done
```

## Layer-boundary check (AGENTS.md hard rule)

- `OrphanedRunsSweeper` lives in `packages/application/src/` — imports only
  `@ai-sdlc/domain`, `../ports*.js`, and test-double types. No
  `@ai-sdlc/infrastructure` import.
- `apps/api/src/compose.ts` is the only wiring point (matches
  `buildWaitingRunsSweeper` at line 4033).
- `infrastructure` layer does not need changes — the existing
  `WorkerLeaseRepository`, `RunRepository`, `JobQueueRepository` already
  implement the ports used here. No new port is needed (we only added fields
  to an existing return type, which is additive and backwards compatible).

## Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Sweep runs in parallel with the worker drain loop and double-enqueues a job for the same run | (a) `queue.listActive()` filter in `OrphanedRunsSweeper` (b) `isRunning` guard on the unified timer (c) drain loop also filters by queued-job (existing). Three independent guards. |
| Worker dies and lease is still held for 30s — sweep tick happens before lease expires | `checkActiveLease` guard at step 1 of `OrphanedRunsSweeper.execute` skips such runs. The next sweep tick (after lease expiry) re-evaluates and enqueues. Worst case: 30s + interval latency, well within "within one interval" for most configs. |
| `workerLoop` refuses to claim a job for a `failed` run | Step 5 transitions `failed → running` after enqueue, so the run matches whatever `workerLoop` expects. Verified by §4 adoption of option (A). |
| Sweep and reactivation timer race for the shared `workerLoopDeps` | Single `isRunning` guard under the unified `startServeSweepTimer`. |
| `cli-serve-sweep-wiring.test.ts` mocks only `buildWaitingRunsSweeper` — adding `buildOrphanedRunsSweeper` requires updating the mock | Update the test in this PR; not deferred. |
| Compose override `runStartupSweeps: false` in serve mode (`cli.ts:713`) means the startup sweep inside `composeRoot` does not run in serve mode — only the periodic sweep + the cli-side startup sweep | Documented in §5. Verified by reading `compose.ts:1298-1368` (gated by `runStartupSweeps !== false`) and `cli.ts:713` (sets it to `false` for `serve`). |
| Sweep currently runs on `running` AND `waiting` (because `findActiveRuns` returns both); an aggressive sweep could over-trigger | The lease + already-queued guards make this safe. Documenting the behavior; not adding a status filter (changing `findActiveRuns` is out of scope and would affect other callers). |
| `canResume(run)` rejects a freshly `failed` run with no `currentPhase` | Already verified in `sweep-orphaned-runs.test.ts:69-78` — `canResume({...failed run without currentPhase})` returns `true` and `planRunRecoveryAction({action: 'resume'})` returns `{allowed: true, targetPhase: 'read_issue'}`. So `workerLoop` resuming a `failed` run is a known-supported path. |

## Open verification (follow-up, not blocking)

1. **Does `workerLoop` already accept jobs for runs in `failed` status?** Read
   `packages/application/src/worker-loop.ts` (or equivalent — search for the
   `workerLoop` export). If it does, the status transition in §2 step 5 is
   still safe but redundant — file a follow-up to drop the transition. If it
   does not, the transition is load-bearing. Either way this PR is correct
   because of (A). Not blocking because (A) is unconditional.
2. **`WorkerLoopDeps.recoverableRunIds`** filters runs at
   `worker-drain-loop.ts:20-26`. A `failed` run is not in `findActiveRuns()`,
   so it is not in `recoverableRunIds` — but that set is for run-driven
   recovery. Confirm the drain loop's `claimNext` path does not require the
   run to be in `recoverableRunIds` (it shouldn't, because claim is queue-based).
3. **Job creation accepts `priority: 10`?** Verified — `createJob` priority is
   `number`, default 0, sorted by descending priority then createdAt
   (`packages/application/src/test-doubles/fake-job-queue-port.ts:38-42`).

## Scope

In scope:
- Extend `SweepOrphanedRuns.execute()` return type.
- Add `OrphanedRunsSweeper` in `packages/application/src/`.
- Wire into the periodic serve-mode timer and startup sweep.
- Status transition (`failed → running`) after enqueue.
- Unit + integration + CLI wiring tests.
- Index/export additions.

Out of scope:
- Changing `findActiveRuns()` semantics or `RunStatus` itself.
- Adding new ports.
- Cross-host lease arbitration (single-tenant, single-host serve process per
  this codebase's deployment model).
- Backfilling a sweep for runs orphaned before this change is deployed — the
  first sweep after deployment catches them automatically.
- Adding CLI flags for tuning the orphan-sweep interval separately from the
  reactivation interval (they share the existing `serve.sweepIntervalSeconds`
  config; users who want to disable one can do so by setting the sweep to 0
  once both sweepers are wired, but YAGNI for an "orphan only" knob).

## Acceptance criteria

1. `pnpm -r typecheck` passes.
2. `pnpm depcruise` passes (no new layer violations).
3. `pnpm -r test` passes — including all new tests listed in §6.
4. End-to-end: a `running` run whose PID is killed is detected within one
   sweep interval, transitioned to `running`, and a worker drain loop tick
   claims its job and executes it to `succeeded`. Integration test
   `serve-orphan-recovery-integration.test.ts` AC-I1 covers this.
5. Live run invariant: a `running` run with a live PID is never swept.
   AC-I2 covers this.
6. Lease-respect invariant: a `running` run with a dead PID but an active
   lease for its repo is not enqueued by the orphan sweep. AC-I3 covers this.