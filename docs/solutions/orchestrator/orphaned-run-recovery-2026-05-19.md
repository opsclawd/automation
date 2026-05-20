---
title: Orphaned run recovery — defense-in-depth for interrupted orchestrator runs
date: 2026-05-19
category: orchestrator
module: packages/domain, packages/infrastructure, packages/application, apps/api
problem_type: stuck_state_no_recovery
component: run_lifecycle
symptoms:
  - "An active run already exists for issue N" error on re-run after crash/SIGTERM
  - Rows in orchestrator.sqlite stuck with status='running'
  - Manual SQLite mutation required to unblock
root_cause: missing_signal_handlers_and_orphan_detection
resolution_type: defense_in_depth
severity: high
related_components:
  - sqlite
  - cli
  - composition_root
tags:
  - orphaned-runs
  - signal-handlers
  - startup-sweep
  - pid-tracking
  - cancel-run
  - defense-in-depth
  - layered-architecture
---

# Orphaned run recovery — defense-in-depth for interrupted orchestrator runs

## Problem

When `pnpm --filter @ai-sdlc/api dev run --issue N` is interrupted before reaching a terminal state (SIGTERM, SIGINT, crash, SIGKILL, OOM kill), the SQLite row in `.ai-runs/orchestrator.sqlite` keeps `status='running'`. The next invocation hits `insertIfNoActive` in `RunRepository` (`packages/infrastructure/src/sqlite/run-repository.ts:61-74`) and fails with:

```
An active run already exists for issue N
```

The only workaround was manual SQLite mutation:

```sql
UPDATE runs SET status='cancelled', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE uuid='<stuck-uuid>';
```

Every aborted run permanently blocked that issue number from being retried. High friction during development and CI debugging.

## Design decisions and trade-offs

### Orphan detection mechanism

Three options were considered:

| Option        | Mechanism                                                  | Pros                                                          | Cons                                                                 |
| ------------- | ---------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------- |
| A: PID column | Store process PID, check `process.kill(pid, 0)` on startup | Immediate, no background process, reliable for single-machine | PID reuse risk (mitigated by `/proc/<pid>/stat` start time on Linux) |
| B: Lockfile   | `.ai-runs/<uuid>.lock` file, check for stale locks         | Cross-platform                                                | Adds filesystem complexity, lock cleanup on crash                    |
| C: Heartbeat  | Periodic `last_heartbeat` timestamp update                 | Works across machines                                         | Adds runtime overhead, timing heuristic, background process needed   |

**Decision: Option A (PID column).** The orchestrator is local-first, single-machine (ADR-0001). PID checking is immediate and requires no background process. PID reuse is a theoretical concern but mitigated on Linux by checking `/proc/<pid>/stat` start time.

### Recovery strategy depth

| Option                  | Coverage                                               | Gap                                    |
| ----------------------- | ------------------------------------------------------ | -------------------------------------- |
| Signal handlers only    | SIGINT, SIGTERM, uncaughtException, unhandledRejection | SIGKILL, OOM kill — no handler can run |
| Startup sweep only      | Dead-PID rows detected on next startup                 | No immediate cleanup on graceful exit  |
| Both (defense in depth) | Full coverage                                          | Slightly more code                     |

**Decision: Both.** Signal handlers provide immediate, clean state on graceful exits. Startup sweep covers hard kills where no handler runs. The startup sweep is the safety net; signal handlers are the fast path.

### Manual override CLI

**Decision: `orchestrator runs cancel --issue N [--reason R]` and `--uuid U [--reason R]`.** Eliminates the need for manual SQLite mutation. The PRD already listed "cancel active run" as a user story (#16).

## Implementation architecture

Changes respect the layered architecture (domain → application → infrastructure → apps/api composition root):

```
apps/api (composition root)
  ├── signal handlers on `run` command action (cli.ts:69-116)
  ├── startup sweep in composeRoot() (compose.ts:60-68)
  └── `runs cancel` subcommand (cli.ts:165-228)
packages/application/
  ├── CancelRun use case (cancel-run.ts)
  └── SweepOrphanedRuns use case + checkPid helper (sweep-orphaned-runs.ts)
packages/infrastructure/
  ├── Migration 0002: add pid INTEGER to runs table
  ├── RunRepository: pid recording on insert (run-repository.ts:38-59, 71)
  ├── RunRepository: findByIssueNumber (run-repository.ts:148-153)
  ├── RunRepository: findActiveRuns (run-repository.ts:155-162)
  └── RunRepository: updateStatusByIssueNumber (run-repository.ts:164-180)
packages/domain/
  └── cancelRun() domain function (run.ts:102-114)
```

## Key implementation details

### 1. Migration 0002 — `pid` column

File: `packages/infrastructure/src/sqlite/migrations/0002-add-pid-column.ts`

Simple `ALTER TABLE runs ADD COLUMN pid INTEGER`. Existing rows get `NULL`. The startup sweep skips `NULL`-PID rows (can't verify liveness) — they require one-time manual cancellation via the new CLI command.

### 2. Domain: `cancelRun()`

File: `packages/domain/src/run.ts:102-114`

Mirrors `passRun`/`failRun` pattern:

- Throws `RunStateError` if run is already terminal (`passed`, `failed`, `cancelled`)
- Sets `status='cancelled'`, `completedAt`, optional `failureReason`
- Deletes `currentPhase`

### 3. Infrastructure: `RunRepository` extensions

File: `packages/infrastructure/src/sqlite/run-repository.ts`

**`insert(run, pid?)`** — accepts optional `pid` parameter, stored as `pid: pid ?? null` in the SQL INSERT.

**`insertIfNoActive(run)`** — now passes `process.pid` to `insert()` (line 71). The active-run check query remains unchanged: `status NOT IN ('passed','failed','cancelled')`.

**`findByIssueNumber(issueNumber)`** — returns the most recent run for an issue (`ORDER BY started_at DESC LIMIT 1`).

**`findActiveRuns()`** — returns all rows where `status NOT IN ('passed','failed','cancelled')`. Used by the startup sweep.

**`updateStatusByIssueNumber(issueNumber, patch)`** — updates `status`, `completed_at`, `failure_reason` by issue number. Only affects non-terminal rows (`WHERE status NOT IN (...)`). Returns `boolean` (`result.changes > 0`) so callers know if anything was actually updated. This is critical for the signal handler — it's safe to call even if no run exists (returns `false`, no-op).

**`RunRecord` type** — extends domain `Run` with `exitCode?`, `durationMs?`, `pid?`. Duplicated in `packages/application/src/ports.ts` (see layer boundary note below).

### 4. Application: `CancelRun` use case

File: `packages/application/src/cancel-run.ts`

```typescript
export class CancelRun {
  constructor(private readonly deps: CancelRunDeps) {}

  execute(input: CancelRunInput): void {
    const now = this.deps.now ?? (() => new Date());
    const existing = this.deps.runRepository.findByIssueNumber(input.issueNumber);
    if (!existing) {
      throw new Error(`No active run found for issue ${input.issueNumber}`);
    }
    // Use domain function to validate terminal state and derive canonical patch
    const cancelled = cancelRun(existing, input.reason, now());
    const updated = this.deps.runRepository.updateStatusByIssueNumber(input.issueNumber, {
      status: cancelled.status,
      completedAt: cancelled.completedAt!,
      ...(cancelled.failureReason ? { failureReason: cancelled.failureReason } : {}),
    });
    if (!updated) {
      throw new Error(`Run for issue ${input.issueNumber} is already ${existing.status}`);
    }
  }
}
```

**Design note:** Uses the domain `cancelRun()` function to validate the terminal-state check and derive the canonical patch, then applies it via `updateStatusByIssueNumber`. This keeps the domain function as the single source of truth for cancellation semantics. The `updateStatusByIssueNumber` return value provides a double-check against race conditions (another process cancelled between the lookup and the update).

### 5. Application: `SweepOrphanedRuns` use case

File: `packages/application/src/sweep-orphaned-runs.ts`

```typescript
export class SweepOrphanedRuns {
  execute(): { swept: number } {
    const activeRuns = this.deps.runRepository.findActiveRuns();
    for (const run of activeRuns) {
      if (run.pid === undefined || run.pid === null) continue;
      if (!this.deps.isProcessAlive(run.pid)) {
        this.deps.runRepository.updateStatusByIssueNumber(run.issueNumber, {
          status: 'cancelled',
          completedAt: now(),
          failureReason: `orphaned: process ${run.pid} no longer running`,
        });
        swept++;
      }
    }
    return { swept };
  }
}
```

**`checkPid(pid)`** helper (same file, lines 36-42):

```typescript
export function checkPid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
```

Injected as `isProcessAlive` dependency so it can be mocked in tests. On Linux, a more robust version could check `/proc/<pid>/stat` start time to guard against PID reuse, but the current implementation uses the portable `process.kill(pid, 0)` approach.

**Skips runs with `null`/`undefined` PID** — pre-migration rows with no PID cannot be verified, so they're left alone. This is a one-time transition cost.

### 6. CLI: signal handlers on `run` command

File: `apps/api/src/cli.ts:69-116`

The `run` command action installs four handlers before calling `startIssueRun.execute()`:

- `SIGINT` → cancels run, exits 130
- `SIGTERM` → cancels run, exits 143
- `uncaughtException` → cancels run, logs error, exits 1
- `unhandledRejection` → cancels run, logs reason, exits 1

All handlers are removed in a `finally` block after `execute()` completes.

**Key design decision:** The cleanup function uses `updateStatusByIssueNumber(opts.issue, ...)` instead of `update(uuid, ...)`. This avoids needing to track the run UUID across the `insertIfNoActive` → `execute()` boundary. `updateStatusByIssueNumber` is safe to call even if no run exists yet (returns `false`, no rows affected) or if the run is already terminal (also returns `false`). This eliminates the race window concern from the original design doc.

**better-sqlite3 is synchronous** — `updateStatusByIssueNumber` is a synchronous SQLite call, safe inside signal handler callbacks. The `cleanup` function is `async` only for `.finally()` chaining to `process.exit()`.

### 7. CLI: startup sweep in `composeRoot()`

File: `apps/api/src/compose.ts:60-68`

Called after `applyMigrations(db)` and `new RunRepository(db)`, before any use case is constructed:

```typescript
const sweep = new SweepOrphanedRuns({
  runRepository,
  isProcessAlive: checkPid,
});
const sweepResult = sweep.execute();
if (sweepResult.swept > 0) {
  console.error(`Recovered ${sweepResult.swept} orphaned run(s)`);
}
```

This runs on every `composeRoot()` call — both `run` and `serve` commands. The sweep is idempotent and fast (single query + PID checks).

### 8. CLI: `runs cancel` subcommand

File: `apps/api/src/cli.ts:165-228`

```
orchestrator runs cancel --issue <number> [--reason <string>]
orchestrator runs cancel --uuid <uuid> [--reason <string>]
```

- `--issue` path: delegates to `CancelRun` use case
- `--uuid` path: uses `runRepository.findByUuid()`, then calls domain `cancelRun()` directly and applies via `updateStatusByIssueNumber`. This path uses the domain function directly (imported from `@ai-sdlc/domain` at `cli.ts:5`) rather than the `CancelRun` use case, because the use case only accepts `issueNumber`.
- Validates `--issue` and `--uuid` are mutually exclusive and at least one is provided
- Validates run exists and is non-terminal before cancelling

## Layer boundary: `RunRecord` duplication

`RunRecord` is defined in two places:

- `packages/infrastructure/src/sqlite/run-repository.ts:29-33` (exported)
- `packages/application/src/ports.ts:15-29` (not exported from infrastructure)

This duplication is **required** by the layer boundary rule: `packages/application/**` MUST NOT import `@ai-sdlc/infrastructure`. Both definitions must stay in sync manually. If a new field is added to one, add it to the other as well. Both files include a `NOTE` comment documenting this.

## Gotchas and pitfalls

### 1. Signal handler race window (acceptable)

The original design doc noted a race between `insertIfNoActive` and signal handler installation. The actual implementation avoids this by using `updateStatusByIssueNumber(opts.issue, ...)` — it doesn't need the UUID, so there's no tracking variable to set. If the signal fires before `insertIfNoActive` completes, the update is a no-op (0 rows affected). The startup sweep on the next invocation covers any orphaned row.

### 2. `process.exit()` doesn't flush stdout

The `run` command uses `process.stdout.write(JSON.stringify(out) + '\n', callback)` instead of `console.log()` because `process.exit()` does not wait for stdout to flush. The callback-based Promise ensures the JSON is written before exit. See `cli.ts:105-109`.

### 3. `cancelRun` use case uses domain function for validation

The `CancelRun.execute()` method calls the domain `cancelRun()` function to validate the terminal-state check, then applies the result via the repository. This is different from a naive approach that would check `existing.status` directly. The domain function is the single source of truth for what "terminal" means. If the terminal status set changes, only the domain needs updating.

### 4. `updateStatusByIssueNumber` guards against overwriting terminal runs

The SQL `WHERE status NOT IN ('passed','failed','cancelled')` clause prevents accidentally overwriting a run that reached a terminal state between the lookup and the update. The boolean return value lets callers detect this case.

### 5. Pre-migration rows with NULL PID

Rows created before migration 0002 have `pid = NULL`. The startup sweep skips them (`if (run.pid === undefined || run.pid === null) continue`). They require one-time manual cancellation via `orchestrator runs cancel --issue N`. This is acceptable as a transition cost.

### 6. `checkPid` is Linux-optimized but portable

`process.kill(pid, 0)` works on all POSIX systems. On Linux, PID reuse could theoretically cause a false negative (a new process reuses the dead orchestrator's PID). The design doc mentions checking `/proc/<pid>/stat` start time for mitigation, but the current implementation uses the portable approach. In practice, PID reuse within the short window between orchestrator death and next startup is extremely unlikely.

## What to know before modifying this code

### Adding a new field to `RunRecord`

Update **both** definitions:

1. `packages/infrastructure/src/sqlite/run-repository.ts` — `RunRow` interface, `toRecord()` function, `RunRecord` interface
2. `packages/application/src/ports.ts` — `RunRecord` interface

### Changing terminal statuses

`TERMINAL_STATUSES` is defined in `packages/domain/src/run.ts:11`. All three mechanisms (signal handlers, startup sweep, `runs cancel`) use `status NOT IN ('passed','failed','cancelled')` in SQL queries. If the terminal set changes, update:

- `TERMINAL_STATUSES` in `run.ts`
- The SQL `NOT IN` clauses in `run-repository.ts` (three locations: `insertIfNoActive`, `findActiveRuns`, `updateStatusByIssueNumber`)

### Testing signal handlers

Signal handlers are hard to unit test in isolation. The `SweepOrphanedRuns` use case is fully testable via the injected `isProcessAlive` mock. Signal handler behavior should be verified with integration tests that send signals to a running process.

### Adding a new repository method

If you need a new `RunRepository` method that the application layer uses, add the method to:

1. `packages/infrastructure/src/sqlite/run-repository.ts` (implementation)
2. `packages/application/src/ports.ts` — `RunRepositoryPort` interface (type signature)

Do NOT import from `@ai-sdlc/infrastructure` in application code.

## Files changed

| File                                                                   | Change                                                                                                                                                               |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/domain/src/run.ts`                                           | Added `cancelRun()` function                                                                                                                                         |
| `packages/domain/src/__tests__/cancel-run.test.ts`                     | Tests for `cancelRun()`                                                                                                                                              |
| `packages/infrastructure/src/sqlite/migrations/0002-add-pid-column.ts` | New migration: `ALTER TABLE runs ADD COLUMN pid INTEGER`                                                                                                             |
| `packages/infrastructure/src/sqlite/migrations.ts`                     | Registered migration 0002                                                                                                                                            |
| `packages/infrastructure/src/sqlite/run-repository.ts`                 | Added `pid` to `RunRow`, `insert()`, `insertIfNoActive()`, `toRecord()`, `RunRecord`; added `findByIssueNumber()`, `findActiveRuns()`, `updateStatusByIssueNumber()` |
| `packages/infrastructure/src/sqlite/__tests__/migrations-0002.test.ts` | Tests for migration 0002                                                                                                                                             |
| `packages/infrastructure/src/sqlite/__tests__/run-repository.test.ts`  | Tests for new repository methods + PID recording                                                                                                                     |
| `packages/application/src/ports.ts`                                    | Added `RunRecord` type, extended `RunRepositoryPort` with `findByIssueNumber`, `findActiveRuns`, `updateStatusByIssueNumber`                                         |
| `packages/application/src/cancel-run.ts`                               | New `CancelRun` use case                                                                                                                                             |
| `packages/application/src/__tests__/cancel-run.test.ts`                | Tests for `CancelRun`                                                                                                                                                |
| `packages/application/src/sweep-orphaned-runs.ts`                      | New `SweepOrphanedRuns` use case + `checkPid` helper                                                                                                                 |
| `packages/application/src/__tests__/sweep-orphaned-runs.test.ts`       | Tests for `SweepOrphanedRuns`                                                                                                                                        |
| `packages/application/src/index.ts`                                    | Exports for new use cases                                                                                                                                            |
| `apps/api/src/cli.ts`                                                  | Signal handlers on `run` command, `runs cancel` subcommand                                                                                                           |
| `apps/api/src/compose.ts`                                              | Startup sweep, `CancelRun` in container                                                                                                                              |
| `apps/api/src/__tests__/cli.test.ts`                                   | Tests for `runs cancel` subcommand                                                                                                                                   |
| `apps/api/src/__tests__/compose.test.ts`                               | Test for startup sweep integration                                                                                                                                   |
