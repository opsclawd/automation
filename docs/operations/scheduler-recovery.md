# Scheduler Recovery Operations

This guide covers scheduler recovery behavior, database topology, worker lifecycle, and operator procedures for the AI SDLC Orchestrator.

## Database Topology

The orchestrator uses two SQLite databases with distinct roles:

### Control Plane (`control.sqlite`)

The control plane database is the single central registry. It lives at `.ai-runs/control.sqlite` in the installation root and contains:

- **repositories** — registered repositories, their health status, and enabled state
- **workers** — worker registration records (hostname, PID, heartbeat, status)
- **configuration** — scheduler settings, global concurrency limits

The control plane is shared across all repositories and worker processes on the same host.

### Per-Repository Operational Database (`operational.sqlite`)

Each registered repository has its own operational database at `<repoRoot>/.ai-runs/operational.sqlite`. It contains:

- **runs** — run identity, status, phase, artifacts, and lifecycle state
- **jobs** — job queue with claim/lease tokens, priority, and status
- **worker_leases** — active per-repository leases with heartbeat and expiry
- **events** — per-repository audit trail
- **artifacts** — artifact manifest and file paths

This separation ensures:
- Per-repository event audit trails with unambiguous `repoId` binding
- Query isolation — one repository's load does not contend with another's
- Potential future per-repo data retention without cross-repo contamination

### Embedded Mode

In embedded mode (`pnpm --filter @ai-sdlc/api dev serve`), the API process runs an in-process scheduler and worker pool. The same SQLite files are opened by the same process; no cross-process coordination is needed.

### Standalone Mode

In standalone mode (`pnpm --filter @ai-sdlc/api dev worker start`), the worker process opens the same operational SQLite files as the API. SQLite WAL mode permits concurrent reads from multiple processes; writes are serialized per-file by SQLite's journal.

## Concurrency Model

### Global Concurrency

`globalConcurrency` bounds how many dispatches may be in-flight across ALL repositories simultaneously. The counter is **process-local** — each coordinator process enforces its own limit independently. Multiple standalone workers on the same host each run their own coordinator with independent counters.

### Repository-Scoped Concurrency

Within a single repository, `WorkerLease` enforces that **only one worker holds the lease at any moment**. This is a database-level invariant enforced by:

1. **Job claim** — a worker atomically claims a job with a `claimToken` and `claimExpiresAt`
2. **Lease acquisition** — after claiming, the worker acquires a `WorkerLease` with a `leaseToken`, `heartbeatAt`, and `expiresAt`

The `(workerId, runId)` pair embedded in the `leaseToken` serves as a **generation fence**: any mutation (heartbeat, release, reclamation) must present the exact `leaseToken` that was issued. A stale process that tries to heartbeat an expired lease that has since been reissued will fail because the token has changed.

### One-Host Requirement

Multiple worker processes are supported **only on one host**. The scheduler uses local PID checks and hostname comparison to determine worker liveness. Cross-host lease recovery is not supported because:

- PID reuse is ambiguous across hosts
- A process alive on host B with the same PID as a dead process on host A cannot be distinguished without shared state
- The `WorkerLease` table has no cross-host liveness mechanism

If you attempt to run workers across multiple machines, the recovery coordinator will be unable to distinguish a living remote worker from a PID-reused zombie, and will block recovery indefinitely.

## Lease and Claim Tokens

### `leaseToken`

A randomly generated token issued when a worker acquires a `WorkerLease`. The token is opaque to the domain; only the worker that holds it may heartbeat or release the lease. The `(workerId, runId)` embedded in the lease row is the **generation** — reclaiming a stale lease requires matching both the generation and the exact token.

### `claimToken`

A randomly generated token issued when a worker claims a `Job`. The job is in `claimed` status until the worker starts execution or the claim expires. The `claimToken` is independent of the `leaseToken`; a worker may hold a lease without an active claim, or a claim without a lease (though the normal lifecycle acquires them together).

### Heartbeat and Fencing

Workers heartbeat their lease by extending `heartbeatAt`. If a worker fails to heartbeat before `expiresAt`, the lease is considered stale. The generation fence prevents a new worker from reclaiming a lease unless:

1. The old lease's `expiresAt` has passed
2. The owning worker is confirmed stale (dead PID, unhealthy, or stopping)
3. The new worker provides the exact `leaseToken` of the generation it is reclaiming

This ensures that a late-surviving old process cannot mutate state under a new generation.

## Recovery State Machine

The `RepositoryRecoveryCoordinator` evaluates each repository on every schedule pass. It produces one of the following actions:

| Action | Condition |
|--------|-----------|
| `leave` | Active lease exists, or active non-expired jobs exist, or nothing to recover |
| `requeue` | Expired claim with no active lease — job is reset to `queued` |
| `reclaim` | Stale lease with recoverable run AND (no active jobs OR repo disabled) |
| `orphan-enqueue` | Stale lease with recoverable run, no active jobs, repo enabled — orphan recovery job enqueued |
| `waiting-reactivate` | `waiting` run exists with repo enabled — re-enqueue the waiting job |

### Startup Barrier

On process startup, the scheduler **waits for an initial recovery sweep to complete** before admitting new dispatches. This prevents a freshly-started process from scheduling work into a repository that is already being recovered by another process.

### Disable Policy

Setting `enabled=false` on a repository:
- Drains admitted work: in-flight dispatches complete normally
- Blocks new work: subsequent schedule passes skip the disabled repository

### Unavailable Policy

Repositories with `healthStatus` of `unreachable`, `unknown`, or `degraded` are skipped. Missing local paths or runtime construction failures are treated as unavailable. The scheduler records a `scheduler.repository.skipped` telemetry event.

## Shutdown and Grace Fallback

### Cooperative Shutdown

When a worker receives SIGTERM, it:
1. Stops accepting new dispatches
2. Drains in-flight work (up to `shutdownGraceMs`)
3. Releases its leases and claims
4. Exits cleanly

During graceful drain, the worker **does not** release ownership until the child process has exited. If the child process is still running when `shutdownGraceMs` elapses, the worker falls through to the crash-equivalent path.

### Crash-Equivalent Non-Cooperative Shutdown

If the worker is killed (SIGKILL) or fails to drain within `shutdownGraceMs`, it is treated as a crash. The lease is not released — it simply expires. Recovery kicks in on the next schedule pass as if the worker had died.

The `lease.reclaimed` audit event records the transition, including the reason (`stale lease recovery` vs `coordinator shutdown`).

## Recovery State Table

The `operational_recovery_inspection` view (or `OperationalRecoveryPort.inspect()`) exposes:

```
hasActiveLease: boolean
activeLease?: { repoId, workerId, runId, leaseToken, acquiredAt, heartbeatAt, expiresAt }
hasActiveJob: boolean
activeJob?: { id, runId, status, claimedBy, claimToken, claimExpiresAt }
```

This table is the basis for all recovery decisions. The coordinator queries it before every schedule pass.

## Audit Events

Every recovery action emits a typed event to the repository's event log:

| Event | Fields |
|-------|--------|
| `lease.acquired` | `repoId`, `workerId`, `runId`, `leaseToken` |
| `lease.heartbeat` | `repoId`, `workerId`, `runId` |
| `lease.released` | `repoId`, `workerId`, `runId`, `leaseToken`, `reason` |
| `lease.reclaimed` | `repoId`, `previousWorkerId`, `previousRunId`, `reclaimedByWorkerId`, `leaseToken`, `reason` |
| `job.claimed` | `repoId`, `jobId`, `runId`, `workerId`, `claimToken` |
| `job.completed` | `repoId`, `jobId`, `runId`, `status` |
| `run.orphan-enqueued` | `repoId`, `runId`, `previousWorkerId`, `reason` |

## Operator Procedures

### Restore a Moved or Deleted Checkout

If a repository's checkout is moved or deleted while a run is active:

1. **Quarantine the old worktree** (if it still exists):
   ```bash
   mv /path/to/worktree /path/to/worktree-quarantined-$(date +%s)
   ```

2. **Restore from backup or reclone**:
   ```bash
   git clone https://github.com/owner/repo.git /path/to/repo
   ```

3. **Reset to the last known-good commit** (the run's `baseBranch` or `lastGoodCommit`):
   ```bash
   git -C /path/to/repo checkout <baseBranch>
   git -C /path/to/repo reset --hard <lastKnownGoodCommit>
   ```

4. **Refresh repository health** via the API:
   ```bash
   curl -X POST http://127.0.0.1:4319/api/repositories/<repoId>/refresh-health
   ```

5. **Verify health status** is `healthy` before retrying:
   ```bash
   curl http://127.0.0.1:4319/api/repositories/<repoId> | jq '.healthStatus'
   ```

6. **Retry the run**:
   ```bash
   pnpm --filter @ai-sdlc/api dev run --issue <issueNumber>
   ```

### Manual Lease Release

If a lease is stuck (worker died without recovery triggering):

```bash
sqlite3 .ai-runs/operational.sqlite \
  "DELETE FROM worker_leases WHERE repo_id = 'owner/repo' AND worker_id = 'w1'"
```

Then refresh health and retry. This is a last resort — prefer the automatic recovery path.

### Inspecting Recovery State

```bash
# View active leases
sqlite3 .ai-runs/operational.sqlite "SELECT * FROM worker_leases"

# View jobs in non-terminal states
sqlite3 .ai-runs/operational.sqlite \
  "SELECT * FROM jobs WHERE status IN ('queued', 'claimed', 'running')"

# View recent recovery audit events
sqlite3 .ai-runs/operational.sqlite \
  "SELECT * FROM events WHERE type = 'lease.reclaimed' ORDER BY timestamp DESC LIMIT 10"
```

## Failure Injection Coverage

The following failure scenarios are covered by integration tests:

| Scenario | Test file |
|----------|-----------|
| SIGKILL restart with startup barrier | `restart-recovery.failure-injection.test.ts` |
| Cooperative SIGTERM drain | `shutdown-recovery.failure-injection.test.ts` |
| Non-cooperative SIGTERM (grace expired) | `shutdown-recovery.failure-injection.test.ts` |
| Expired lease recovery with generation fence | `restart-recovery.failure-injection.test.ts` |
| Blocked operational open (one repo) while other recovers | `multi-repository-recovery.failure-injection.test.ts` |
| Concurrent recovery on two repos | `multi-repository-recovery.failure-injection.test.ts` |
| Late killed owner cannot heartbeat reclaimed generation | `restart-recovery.failure-injection.test.ts` |
