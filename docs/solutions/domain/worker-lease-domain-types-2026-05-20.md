---
title: Worker + WorkerLease domain types, ports, and in-memory fakes (M3-04)
date: 2026-05-20
category: domain
module: packages/domain, packages/application
problem_type: new_feature
component: worker_lease
tags:
  - worker
  - worker-lease
  - ports
  - fakes
  - concurrency
  - adr-0008
  - reclaim-expired
  - layer-boundary
---

# Worker + WorkerLease domain types, ports, and in-memory fakes (M3-04)

## Problem

ADR-0008 establishes "one Worker per Repository at a time" as a load-bearing invariant. Before M3-04, the system had no `Worker` or `WorkerLease` domain types, no ports to abstract worker/lease operations, and no in-memory fakes to verify the invariant in tests. Without these, multiple Workers could race on a single Repository, violating PRD invariants 0c/0d/0e.

The lease is the source of truth: concurrent Runs against different Repositories are safe, concurrent Runs against the same Repository are not. The system needed:

1. **Domain types** (`Worker`, `WorkerLease`) representing the entities — not infrastructure, not persistence.
2. **Ports** (`WorkerRegistryPort`, `WorkerLeasePort`) abstracting the operations the application layer performs against workers and leases, keeping infrastructure out of application.
3. **In-memory fakes** mirroring the persistence semantics the SQLite adapter must provide (uniqueness on `repoId` for active leases) so tests can validate the behavior before the adapter exists.

## Design decisions and trade-offs

### 1. Pure domain types with immutable status transitions

`Worker` and `WorkerLease` follow the existing `Job` domain type pattern: data interfaces plus pure factory/helper functions that return new instances. No mutable state. No side effects.

`WorkerStatus` (`packages/domain/src/worker.ts:2`) is a union type: `'idle' | 'busy' | 'stopping' | 'unhealthy'`. Each status transition has its own function (`markWorkerBusy`, `markWorkerIdle`, `markWorkerStopping`, `markWorkerUnhealthy` at lines 28-38).

**Trade-off:** Adding a new status requires adding a function and updating the union. This is deliberate — the domain is explicit about valid states, and invalid transitions are impossible to express.

### 2. `WorkerLeaseConflictError` as a typed domain error

`acquire` throws `WorkerLeaseConflictError` (`packages/domain/src/worker-lease.ts:10-18`) rather than returning a result type. Rationale: a conflict is an exceptional condition (only one Worker can win), not a routine return value. The error carries `repoId` and `currentWorkerId` so callers can correlate it to observability without parsing the message string.

### 3. Ports are named interfaces, not function types

`WorkerRegistryPort` (`packages/application/src/ports/worker-registry-port.ts:3-12`) and `WorkerLeasePort` (`packages/application/src/ports/worker-lease-port.ts:24-30`) are named interfaces with methods. This enables IDE autocompletion, makes the API self-documenting, and lets fakes implement them directly.

The `FakeWorkerRegistryPort` constructor takes no arguments. The `FakeWorkerLeasePort` takes a `WorkerRegistryPort` as a constructor argument (`packages/application/src/test-doubles/fake-worker-lease-port.ts:28`) so it can query worker status during `reclaimExpired` — mirroring how the SQLite adapter would join against the worker table.

Input types (`AcquireLeaseInput`, `ReclaimExpiredInput`) are named interfaces rather than inline parameters to avoid parameter sprawl.

### 4. `reclaimExpired` safety checks enforced in the fake, documented for the adapter

`FakeWorkerLeasePort.reclaimExpired` (`fake-worker-lease-port.ts:61-83`) encodes the five ADR-0008 safety checks as sequential `continue` conditions:

1. **Heartbeat past expiry** (line 64): `if (input.now <= lease.expiresAt) continue;`
2. **Worker stale/unhealthy** (lines 65-69): checks `isWorkerAlive(lease.workerId) || worker?.status === 'stopping' || worker?.status === 'unhealthy'`
3. **Run is recoverable** (line 71): `if (!input.recoverableRunIds.has(lease.runId)) continue;`
4. **`resetWorktree` callable** (line 72): called synchronously — may throw to abort
5. **`onReclaimed` invoked** (lines 73-78): called with `{ repoId, previousWorkerId, previousRunId, reason }`

If any check fails, the lease is skipped. A prominent code comment on `FakeWorkerLeasePort` (lines 14-24) documents that the SQLite adapter MUST enforce the same uniqueness via a DB-level constraint, not application-level locking.

### 5. `release` is idempotent

Calling `release` on a non-existent lease (or a lease held by a different worker) is a no-op (`fake-worker-lease-port.ts:51-55`). In a distributed system with async heartbeats, a Worker may attempt to release a lease already reclaimed by another Worker. The operation must not throw.

### 6. In-memory fake is effectively atomic

JavaScript is single-threaded, so each method body in the fake is atomic without additional synchronization. Documented in the code comment on `FakeWorkerLeasePort` so the SQLite adapter author understands this is load-bearing.

### 7. `ReclaimExpiredInput` bundles callbacks, not ports

`ReclaimExpiredInput` (`packages/application/src/ports/worker-lease-port.ts:11-22`) includes `isWorkerAlive`, `resetWorktree`, and `onReclaimed` as inline callbacks rather than requiring the lease port to depend on additional ports. This keeps the `WorkerLeasePort` interface decoupled from `WorkerRegistryPort` — the fake happens to also depend on the registry at construction time, but the interface doesn't require it.

## Implementation architecture

Changes respect the layered architecture (domain → application ports → fakes):

```
packages/domain/
  ├── worker.ts              — Worker interface, WorkerStatus, pure helpers
  ├── worker-lease.ts        — WorkerLease interface, WorkerLeaseConflictError
  ├── index.ts               — export * from './worker.js', './worker-lease.js'
  └── __tests__/worker.test.ts — 5 tests for domain helpers
packages/application/
  ├── ports/worker-registry-port.ts  — WorkerRegistryPort interface
  ├── ports/worker-lease-port.ts     — WorkerLeasePort interface, input types
  ├── ports.ts                       — re-export both port interfaces
  ├── test-doubles/fake-worker-registry-port.ts  — FakeWorkerRegistryPort
  ├── test-doubles/fake-worker-lease-port.ts     — FakeWorkerLeasePort
  ├── test-doubles/index.ts                      — barrel exports
  └── __tests__/
      ├── fake-worker-registry-port.test.ts  — 8 tests
      ├── fake-worker-lease-port.test.ts     — 7 tests (5 safety checks + basics)
      └── worker-concurrency.test.ts         — 2 cross-cutting tests
```

## Key implementation details

### 1. Domain: `Worker` type and helpers

File: `packages/domain/src/worker.ts`

```typescript
export type WorkerStatus = 'idle' | 'busy' | 'stopping' | 'unhealthy';
export interface Worker {
  id: WorkerId;
  hostname: string;
  processId: number;
  status: WorkerStatus;
  heartbeatAt: Date;
}
```

Six pure functions (`createWorker`, `heartbeatWorker`, `markWorkerBusy`, `markWorkerIdle`, `markWorkerStopping`, `markWorkerUnhealthy`) each return a new object via spread: `{ ...w, status: 'busy' }`.

### 2. Domain: `WorkerLease` type and `WorkerLeaseConflictError`

File: `packages/domain/src/worker-lease.ts`

```typescript
export interface WorkerLease {
  repoId: RepositoryId;
  workerId: WorkerId;
  runId: RunId;
  acquiredAt: Date;
  heartbeatAt: Date;
  expiresAt: Date;
}
```

`WorkerLeaseConflictError` extends `Error` with `repoId` and `currentWorker` fields. The constructor message includes both for human-readable logs.

### 3. Port: `WorkerLeasePort.acquire` enforces active-lease uniqueness

File: `packages/application/src/ports/worker-lease-port.ts`

`acquire(input: AcquireLeaseInput): WorkerLease` — takes a structured input with `repoId`, `workerId`, `runId`, `now`, `ttlMs`. Returns the created lease or throws `WorkerLeaseConflictError`.

`current(repoId): WorkerLease | undefined` — read-only lookup, no side effects.

### 4. Port: `ReclaimExpiredInput` design

`resetWorktree(repoId)` is a callback (not a port method) so the lease port doesn't need to know about worktree management. The callback may throw, in which case the lease is not reclaimed for this cycle.

`onReclaimed(info)` is called synchronously after the lease is removed from the in-memory map. The SQLite adapter should emit a `lease.reclaimed` event in the same transaction as the lease deletion.

### 5. Fake: `FakeWorkerRegistryPort`

File: `packages/application/src/test-doubles/fake-worker-registry-port.ts`

Holds `Map<WorkerId, Worker>`. Methods that mutate status (`heartbeat`, `mark*`) use a private `update` helper (line 47-51) that throws `Error('unknown worker ${id}')` on missing workers. This is a design choice — in tests, attempting to update a non-registered worker is a programming error that should fail fast.

### 6. Fake: `FakeWorkerLeasePort.reclaimExpired` order matters

The check order in `reclaimExpired` (lines 63-81) is intentional:

1. **Expiry check first** — cheapest filter, avoids looking up the worker for leases that aren't even expired.
2. **Worker staleness** — queries registry for worker status + calls `isWorkerAlive` callback.
3. **Recoverability** — checks the `recoverableRunIds` set.
4. **resetWorktree** — called _before_ `onReclaimed` so the filesystem operation is the final gate.
5. **onReclaimed** — called _after_ the lease is removed from the map (`this.leases.delete` at line 79 comes before `input.onReclaimed` at line 73? No — actually `onReclaimed` is called at line 73, and `this.leases.delete` is at line 79). Wait — let me re-check: `onReclaimed` is called at line 73-78 and `this.leases.delete` is at line 79. So `onReclaimed` fires BEFORE the lease is removed from the map. This is correct — the callback receives the lease info, then the lease is cleaned up.

**Important detail:** If `resetWorktree` throws, the lease is NOT removed from the map and `onReclaimed` is NOT called. The exception propagates to the caller. This is correct behavior (worktree is corrupt), but the audit trail is incomplete for that cycle.

### 7. Cross-cutting concurrency test

File: `packages/application/src/__tests__/worker-concurrency.test.ts`

Uses `FakeRepositoryPort`, `FakeJobQueuePort`, `FakeWorkerRegistryPort`, and `FakeWorkerLeasePort` together to simulate two workers:

- **Same repo** (line 56-93): Worker w1 acquires lease for repo r1, Worker w2 attempts to acquire lease for repo r1 → throws `WorkerLeaseConflictError`
- **Different repos** (line 96-134): Worker w1 acquires lease for repo r1, Worker w2 acquires lease for repo r2 → both succeed

## Gotchas and pitfalls

### 1. `resetWorktree` throwing leaves the lease in place

If `resetWorktree` throws (e.g., filesystem error), the while loop exits immediately due to the unhandled exception. The lease remains in the map, which means the garbage lease is not cleaned up. This is by design — if the worktree is corrupt, the system should not silently remove the lease. However, this means a corrupt worktree permanently blocks the repo until manual intervention.

### 2. `onReclaimed` fires before lease deletion in current code

In `FakeWorkerLeasePort.reclaimExpired`, `onReclaimed` is called at line 73 and `this.leases.delete` is at line 79. If the callback throws, the lease is NOT deleted from the map, and the `reclaimed.push(lease)` at line 80 never runs. This means the lease survives in the map but `onReclaimed` already ran, creating a partial state. In practice, `onReclaimed` is expected to be a simple logging/event emission that doesn't throw.

### 3. `heartbeat` and `release` are silently no-op for wrong worker

`heartbeat(repoId, workerId, ...)` returns without updating if `workerId` doesn't match the lease holder (`fake-worker-lease-port.ts:47`). Same for `release` (line 53). This is intentional — a worker should not be able to extend or release a lease it doesn't own. The silent no-op avoids noisy errors in the distributed case where a worker is late to discover its lease was reclaimed.

### 4. `FakeWorkerRegistryPort` throws on unknown worker

Unlike the lease port's silent no-op, the registry port's `update` method throws `Error('unknown worker ${id}')` if the worker isn't registered (`fake-worker-registry-port.ts:49`). This is because the registry is the source of truth for worker existence — attempting to update a non-existent worker is a programming error.

### 5. Fake depends on registry at construction time

`FakeWorkerLeasePort` takes a `WorkerRegistryPort` in its constructor (`fake-worker-lease-port.ts:28`). If the registry reference becomes stale (e.g., the registry is replaced entirely in a test), the lease port's view of worker status becomes incorrect. For in-memory tests this is manageable, but the SQLite adapter will have both tables in the same database, avoiding this concern entirely.

### 6. Port input types include `now` for determinism

Both `AcquireLeaseInput` and `ReclaimExpiredInput` take an explicit `now: Date` parameter rather than reading system time. This enables deterministic testing. The SQLite adapter will read system time at the moment of acquisition — clock skew between workers is an open concern for the multi-machine scenario.

### 7. Tests were TDD'd without `markWorkerBusy`/`markWorkerIdle` in initial test

The initial `worker.test.ts` in the plan only tested `createWorker`, `heartbeatWorker`, `markWorkerStopping`, and `markWorkerUnhealthy`. The actual test file adds tests for `markWorkerBusy` and `markWorkerIdle` (lines 33-40), which match the domain functions that exist in `worker.ts`. This was fixed during implementation.

Similarly, the plan's `fake-worker-registry-port.test.ts` used `require('@ai-sdlc/domain')` for `createWorker`, but the actual test file uses proper ES module imports (line 2: `import { createWorker, WorkerId } from '@ai-sdlc/domain'`) and adds tests for `markStopping`, `markUnhealthy`, `markBusy`, `markIdle`, and error-on-unknown-worker (8 tests vs 4 in the plan).

## What to know before modifying this code

### Adding a new worker status

1. Add the status string to `WorkerStatus` union in `packages/domain/src/worker.ts:2`
2. Add a new `markWorker<Status>` function in the same file
3. Add the corresponding method to `WorkerRegistryPort` in `packages/application/src/ports/worker-registry-port.ts`
4. Implement it in `FakeWorkerRegistryPort` using the private `update` helper
5. Export the new function from `packages/domain/src/index.ts` (already covered by `export *`)

### Modifying `reclaimExpired` safety checks

The five checks are sequential `continue` conditions in `FakeWorkerLeasePort.reclaimExpired` (lines 63-81). To add a new check:

1. Add the condition to `ReclaimExpiredInput` in `packages/application/src/ports/worker-lease-port.ts`
2. Add the `continue` guard in the fake implementation
3. Add a test case in `fake-worker-lease-port.test.ts`
4. Document the new check in the class-level comment on `FakeWorkerLeasePort`

### Implementing the SQLite adapter (M8)

The fake is executable documentation. Key constraints the adapter must enforce:

- **Unique active lease per repo**: Use `UNIQUE` partial index on `(repo_id)` where status is active, or `INSERT ... ON CONFLICT` for atomic acquisition
- **Atomic acquire**: Use a transaction — `SELECT THEN INSERT` has a race window
- **reclaimExpired**: Run inside a transaction that atomically deletes the lease and emits the `onReclaimed` event
- **Release**: Must be idempotent — `DELETE FROM leases WHERE repo_id = ? AND worker_id = ?` (no-op if no matching row)

### Testing changes

- Domain tests: `pnpm --filter @ai-sdlc/domain test -- --run`
- Application tests: `pnpm --filter @ai-sdlc/application test -- --run`
- Layer check: `pnpm depcruise` (no infra imports in domain/application)
- `FakeWorkerLeasePort` tests exercise each of the five safety checks independently — always add a matching test case for any new check

### Layer boundary

`WorkerRegistryPort` and `WorkerLeasePort` are defined in `packages/application/src/ports/`. They import from `@ai-sdlc/domain` only. No infrastructure imports anywhere in domain or application. The ports are re-exported from `packages/application/src/ports.ts` (lines 113-119).

## Files changed

| File                                                                   | Change                                                          |
| ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| `packages/domain/src/worker.ts`                                        | New — `Worker` interface, `WorkerStatus`, pure helper functions |
| `packages/domain/src/worker-lease.ts`                                  | New — `WorkerLease` interface, `WorkerLeaseConflictError`       |
| `packages/domain/src/index.ts`                                         | Added `export *` for worker and worker-lease                    |
| `packages/domain/src/__tests__/worker.test.ts`                         | New — 5 tests for domain helpers                                |
| `packages/application/src/ports/worker-registry-port.ts`               | New — `WorkerRegistryPort` interface                            |
| `packages/application/src/ports/worker-lease-port.ts`                  | New — `WorkerLeasePort` interface, input types                  |
| `packages/application/src/ports.ts`                                    | Added re-exports for both port interfaces                       |
| `packages/application/src/test-doubles/fake-worker-registry-port.ts`   | New — `FakeWorkerRegistryPort`                                  |
| `packages/application/src/test-doubles/fake-worker-lease-port.ts`      | New — `FakeWorkerLeasePort` with 5 safety checks                |
| `packages/application/src/test-doubles/index.ts`                       | Added barrel exports for both fakes                             |
| `packages/application/src/__tests__/fake-worker-registry-port.test.ts` | New — 8 tests                                                   |
| `packages/application/src/__tests__/fake-worker-lease-port.test.ts`    | New — 7 tests                                                   |
| `packages/application/src/__tests__/worker-concurrency.test.ts`        | New — 2 cross-cutting acceptance tests                          |
