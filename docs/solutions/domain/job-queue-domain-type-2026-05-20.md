---
title: Job Queue domain type and JobQueuePort (M3-03)
date: 2026-05-20
category: domain
module: packages/domain, packages/application
problem_type: new_feature
component: job_queue
symptoms:
  - Manual run starts executed the phase pipeline inline (synchronously in the API process)
  - Violated PRD invariant 0f and ADR-0008 — API must never execute the pipeline inline
  - No decoupling between API and pipeline execution — can't support multi-repo concurrency or clean cancellation
root_cause: missing_async_execution_model
resolution_type: new_feature
severity: medium
related_components:
  - packages/domain/src/job.ts
  - packages/application/src/ports/job-queue-port.ts
  - packages/application/src/test-doubles/fake-job-queue-port.ts
tags:
  - job-queue
  - domain-state-machine
  - port-and-adapter
  - fake-job-queue-port
  - priority-fifo
  - layer-boundary
  - adr-0008
  - m3-03
---

# Job Queue domain type and `JobQueuePort` (M3-03)

## Problem

Manual run starts executed the phase pipeline inline (synchronously inside the API process). This violated PRD invariant 0f and ADR-0008, which require the API to never execute the pipeline inline — it must enqueue a `Job` against a registered `Repository`, and a separate `Worker` process must later claim and execute the Run. Without this decoupling, the orchestrator cannot support multi-repository concurrency, VPS deployment with multiple Workers, or clean cancellation semantics.

## Solution

Three layers:

1. **Domain** (`packages/domain/src/job.ts`): Pure `Job` type with 6 statuses and 6 pure transition functions.
2. **Port** (`packages/application/src/ports/job-queue-port.ts`): `JobQueuePort` interface with 9 methods.
3. **Fake** (`packages/application/src/test-doubles/fake-job-queue-port.ts`): In-memory `FakeJobQueuePort` with priority-FIFO `claimNext`.

### Job domain type (`packages/domain/src/job.ts`)

```typescript
export type JobStatus = 'queued' | 'claimed' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Job {
  id: JobId;
  repoId: RepositoryId;
  runId: RunId;
  status: JobStatus;
  priority: number;
  createdAt: Date;
  claimedAt?: Date;
  completedAt?: Date;
}
```

Six pure transition functions: `createJob`, `claimJob`, `markJobRunning`, `markJobSucceeded`, `markJobFailed`, `markJobCancelled`. Each throws `JobStateError` on illegal transitions.

### `JobQueuePort` interface (`packages/application/src/ports/job-queue-port.ts`)

```typescript
export interface JobQueuePort {
  enqueue(input: EnqueueJobInput): Job;
  claimNext(workerId: WorkerId): Job | undefined;
  markRunning(jobId: JobId): void;
  markSucceeded(jobId: JobId): void;
  markFailed(jobId: JobId): void;
  markCancelled(jobId: JobId): void;
  listForRepo(repoId: RepositoryId): Job[];
  listForRun(runId: RunId): Job[];
  findById(jobId: JobId): Job | undefined;
}
```

### `FakeJobQueuePort`

In-memory `Map<JobId, Job>` backed. `claimNext` sorts queued jobs by descending `priority`, then ascending `createdAt`, then ascending `id` (deterministic tiebreaker). Takes `RepositoryPort` in constructor to enforce repository approval at enqueue time.

## Key design decisions

### Pure domain transitions, impure port

Domain functions (`claimJob`, `markJobRunning`, etc.) take a `Job` and return a new `Job` (immutable). `FakeJobQueuePort` delegates to these pure functions but maintains mutable internal state. This follows the existing `Run` state machine pattern in `packages/domain/src/run.ts`. Making port methods pure was rejected — every caller would need to manage external state for a queue needing atomic claim semantics.

### Priority-FIFO claim ordering

`claimNext` sorts by `priority DESC, createdAt ASC, id ASC`. Highest-priority jobs are always claimed first. Stable ordering prevents starvation of lower-priority jobs while keeping the queue predictable for testing.

### `terminate` guard: only `running` → terminal

```typescript
// Correct: only running → terminal
if (job.status !== 'running') { throw ... }
```

A job must flow through `running` before it can terminate. This is stricter than `Run`'s lifecycle (which permits cancellation from more states). **Do not copy the `Run` pattern's guard logic** — `Job` has a simpler, stricter lifecycle by design.

### `RepositoryPort` injection for cross-port invariant

`FakeJobQueuePort` receives `RepositoryPort` in its constructor and calls `findById(job.repoId)` at enqueue time to reject jobs for unknown/disabled repositories. This avoids duplicating repository lookup logic at call sites.

## Gotchas and pitfalls

### `terminate` guard was too permissive in first iteration

Initial implementation used `TERMINAL.has(job.status)` — meaning it only prevented transitioning _already-terminal_ jobs. This allowed marking `queued` or `claimed` directly as `succeeded`/`failed`/`cancelled`. Fixed to `job.status !== 'running'`.

### Import path for `RepositoryPort` in the fake

`FakeJobQueuePort` imports `RepositoryPort` from `'../ports.js'` (the barrel), not from a port-specific file. `RepositoryPort` is defined inline in `ports.ts`, not in `ports/job-queue-port.ts`. Verify before adding imports.

### Deterministic dates in tests

Tests must use fixed ISO strings (`new Date('2026-01-01T00:00:00Z')`) rather than `Date.now()` offsets. If two dates fall within the same millisecond, ordering is undefined.

### `claimNext` is not thread-safe in the fake

Fine for tests. The real adapter needs transactional SQL with `SELECT ... FOR UPDATE` or equivalent for atomicity across workers.

## What to know before modifying this code

### Adding a new Job status

1. Add the status string to `JobStatus` union in `job.ts`
2. Add a corresponding transition function (or extend an existing one)
3. Update `FakeJobQueuePort` if the new status affects queue behavior
4. Add tests covering the new transition's illegal preconditions

### Implementing the SQLite adapter (M8)

Key constraints:

- **Atomic claim**: Use `INSERT ... ON CONFLICT` or `SELECT THEN INSERT` inside a transaction. `claimNext` must be atomic — two workers claiming the same job is a race.
- **Priority ordering**: Index on `(status, priority DESC, createdAt ASC)` for efficient queue drain.
- **`terminate` enforcement**: The SQL layer must enforce that only `running` jobs can transition to terminal states — foreign key constraints or trigger-based enforcement recommended.

### Changing claim ordering

The `compareJobs` helper in `fake-job-queue-port.ts` defines the ordering. If changed, update both the fake implementation and any tests that depend on specific claim order.

## File map

| File                                                             | Purpose                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------- |
| `packages/domain/src/job.ts`                                     | `Job` type, `JobStatus`, `JobStateError`, 6 lifecycle helpers |
| `packages/domain/src/index.ts`                                   | Re-export `./job.js`                                          |
| `packages/domain/src/__tests__/job.test.ts`                      | 9 tests covering all transitions and illegal states           |
| `packages/application/src/ports/job-queue-port.ts`               | `JobQueuePort` interface, `EnqueueJobInput`                   |
| `packages/application/src/ports.ts`                              | Re-export `JobQueuePort`, `EnqueueJobInput`                   |
| `packages/application/src/test-doubles/fake-job-queue-port.ts`   | In-memory `FakeJobQueuePort`                                  |
| `packages/application/src/test-doubles/index.ts`                 | Re-export `./fake-job-queue-port.js`                          |
| `packages/application/src/__tests__/fake-job-queue-port.test.ts` | 10 tests for fake behavior                                    |

## Verification

```bash
pnpm --filter @ai-sdlc/domain test --run job        # 9 tests
pnpm --filter @ai-sdlc/application test --run fake-job-queue-port  # 10 tests
pnpm -r typecheck && pnpm depcruise
```
