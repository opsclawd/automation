# Single-tenant VPS worker pool and runtime-agnostic agent adapter architecture

> **Implementation status:** Accepted design record; the M1–M8 implementation is complete. Some context and illustrative filenames below describe the proposal at decision time. Use the [README](../../README.md), [operator quickstart](../quickstart.md), and [scheduler recovery guide](../operations/scheduler-recovery.md) for current commands and state paths.

## Status

Accepted.

## Decision

Introduce first-class `Repository`, `Job`, `Worker`, and `WorkerLease` concepts into the domain model, and document a deployment mode that runs the orchestrator on a single VPS with multiple Worker processes under systemd. Manual run start enqueues a `Job` against an approved `Repository`; a `Worker` claims the Job, acquires a per-Repository `WorkerLease`, prepares a worktree, executes the Run through the existing phase pipeline, and releases the lease on success/failure/cancellation. The runtime-agnostic `AgentPort` (ADR-0007) is the only seam through which phase handlers invoke an agent runtime; concrete runtimes (`OpenCodeAgentAdapter`, `PiAgentAdapter`) are registered with an `AgentRuntimeRouter` and selected by configured `AgentProfile` per phase, with explicit fallback policy.

The seams (Repository, Job, Worker, WorkerLease, AgentPort, AgentProfile, AgentRuntimeRouter) are introduced in M3 without executing either runtime. M4 implements the agent runtime adapters. M5–M8 consume these abstractions.

## Context

- M1 and M2 completed local observability around the existing Bash automation. M3 has not started.
- The user wants to manually start issue-to-PR runs against approved GitHub repositories from a browser UI that may run on their developer machine or on a VPS.
- A single approved GitHub identity (token or app installation) is the only authentication surface; the orchestrator is single-user.
- Multiple repositories may run concurrently, but never more than one Worker against the same Repository at the same time — concurrent Runs on the same Repository would race on its working tree, branches, and PR state.
- A second agent runtime is becoming load-bearing: a local Qwen 3.6 27B harness (Pi) with a 64k context window, useful for bounded mechanical work. OpenCode/frontier remains necessary for planning, high-context review, and PR-comment handling.
- Without a Job/Worker/Lease model, the orchestrator can only be safely run as a single inline process, which blocks the VPS scenario and prevents multi-repository concurrency.
- Without a runtime-agnostic AgentPort, every phase handler would have to know which runtime it is calling, and runtime selection would leak into application/domain code.
- Introducing both seams in M3 keeps the abstraction cheap. Adding them later would require rewriting all phase handlers built against a runtime-specific API and a synchronous in-process executor.

## Considered options

**Stay inline, single-process, local-only.** Cheapest in the short term, but blocks running on a VPS, blocks multi-repo concurrency, and concentrates risk on a single developer machine. Rejected: VPS mode is an explicit user goal.

**Adopt a generic distributed job queue (BullMQ/Redis, Sidekiq/Postgres, Temporal, …).** Maximum flexibility, but introduces a second persistent service (Redis or Postgres), a new operational surface, and a much larger blast radius than the problem requires. Rejected: the orchestrator is single-tenant, single-machine, and short-lived workloads fit comfortably inside SQLite + an in-process scheduler.

**SQLite-backed Job table + repo-scoped WorkerLease + N local Worker processes (chosen).** Same SQLite file backs both the orchestration state and the queue. WAL mode and short transactions handle a handful of concurrent Workers. Repo uniqueness on the lease table makes the "one Worker per Repository" invariant a database-level guarantee. No second service; no horizontal scale-out; no leader election. Adding a new runtime is writing a new AgentPort adapter — not adding a new infra component.

**Keep `opencode` hardcoded as the only runtime.** Cheapest in the short term, but blocks local execution and makes cost control impossible. Rejected: Pi/Qwen is already required for bounded mechanical work.

**Generic plug-in runtime registry (anyone can drop in an adapter).** Maximum flexibility, maximum design surface, no near-term need. Rejected: the system is not a generic workflow engine; the closed set of `opencode` and `pi` is sufficient.

## Lease semantics

### Atomic lease acquisition

Domain language uses `WorkerLease`. In persistence the active-lease invariant must be enforced atomically — implementations must use a database-level uniqueness constraint or an equivalent transaction around `repoId` for active leases. A Worker that observes "no active lease for repoId X" and then writes a new lease row must do so inside the same atomic step; two Workers attempting to acquire concurrently must result in exactly one success and one well-typed conflict error. Domain code uses `WorkerLease`; persistence may use locks/transactions internally to acquire the lease safely. The in-memory fake used in M3 mirrors this behaviour with a serialised `acquire`. The one-Worker-per-Repository rule must be enforced by persistence, not convention.

### Generation Fencing

Each `WorkerLease` carries two independent ownership tokens:

- `leaseToken` — a randomly generated token issued at lease acquisition; the holder must present this exact token for any mutation (heartbeat, release, or reclamation)
- `(workerId, runId)` — the **generation** of the lease; the combination acts as a generation fence

The generation fence prevents a late-surviving old process from mutating a lease after it has been reissued. When `commitLeaseReclamation` is called, it atomically verifies that `workerId`, `runId`, and `leaseToken` all match the expected values. If any have changed (because a new worker reclaimed the lease), the reclamation rolls back and reports `lease_generation_changed`.

Similarly, when a job is claimed, a `claimToken` is issued and the `(workerId, jobId)` pair is the job's ownership generation. All mutations require the exact `claimToken`; a `claim_generation_changed` result rolls back the mutation.

### Coordinator-Only Reclamation

Lease reclamation is performed **only by the recovery coordinator** (`RepositoryRecoveryCoordinator`), not by arbitrary workers. The coordinator runs inside the scheduler's schedule loop. This ensures:

- reclamation is ordered and serialised per repository
- competing reclamation attempts from concurrent coordinators are prevented by the generation fence
- audit events (`lease.reclaimed`) are emitted with a consistent `reclaimedByWorkerId`

Workers that lose a lease conflict (through `WorkerLeaseConflictError`) do not attempt to reclaim; they simply skip the conflicting job and retry on the next schedule pass.

### Stale lease recovery — minimum safety checks

A `WorkerLease` may be reclaimed by the coordinator only after **all** of the following hold:

- the lease's `heartbeatAt` is past `expiresAt`;
- the owning Worker's heartbeat is itself stale (or the Worker is marked `unhealthy` / `stopping`);
- if the owning Worker is on the same host, its process is no longer alive or has been marked `unhealthy` / `stopping`;
- the associated Run has been transitioned to `failed` / `cancelled`, or is explicitly marked for recovery by an operator action;
- the repo's worktree has been reset to the last known-good commit, or the worktree has been quarantined under a separate path before reuse;
- a `lease.reclaimed` event is emitted carrying `{ repoId, previousWorkerId, previousRunId, reclaimedByWorkerId, reason }` for auditability.

This list is the documented minimum; concrete adapter implementations may add stricter checks. The fake `WorkerLeasePort` in M3 enforces these checks for tests.

### Crash-Equivalent Non-Cooperative Shutdown Fallback

When a worker receives SIGTERM, it attempts cooperative drain: stopping new dispatches, waiting for in-flight work up to `shutdownGraceMs`, then releasing leases and claims. If the child process is still running when `shutdownGraceMs` elapses, the worker falls through to the crash-equivalent path: it does **not** release ownership, the lease simply expires naturally, and recovery kicks in on the next schedule pass as if the worker had died unexpectedly.

This means a graceful-shutdown-timeout is semantically identical to a crash from the perspective of the recovery coordinator. The distinction is recorded in the `lease.reclaimed` audit event's `reason` field (`stale lease recovery` vs `coordinator shutdown`).

The single-machine invariant is load-bearing here: without a shared host PID table, a worker cannot distinguish a living remote process from a PID-reused zombie, so cross-host lease recovery is blocked.

## Filesystem layout (VPS)

```text
/var/lib/ai-orchestrator/
  repos/
    owner__repo/
      bare.git/
      worktrees/
        issue-123-run-<runId>/
      .ai-runs/
        <runId>/
          prompts/
          logs/
          artifacts/
          diffs/
      operational.sqlite  # per-repository operational state (Jobs, Runs, Workers, leases, events, artifacts)
  control.sqlite  # registry/control plane (Repositories, configuration)
```

Rules:

- No shared mutable checkout across concurrent Runs.
- One active worktree per repo lease.
- Completed worktrees may be cleaned or archived.
- Artifacts remain under the run directory; the repo cache and run artifacts are kept in separate trees.
- **Operational state partitioning**: Jobs, Runs, Workers, leases, events, and artifacts are repository-local operational state stored in each repository's `operational.sqlite`. The registry/control plane (`control.sqlite`) is central and contains repository metadata needed to resolve a Repository. This separation ensures per-repository event audit trails, query isolation, and potential future per-repo data retention.

## systemd services (VPS)

```text
ai-orchestrator-api.service
ai-orchestrator-worker@1.service
ai-orchestrator-worker@2.service
ai-orchestrator-worker@3.service
```

Security assumptions:

- Single approved GitHub identity / token / app installation.
- Tailscale-only access preferred; Cloudflare Access acceptable.
- No public unauthenticated dashboard.
- No arbitrary shell path or repo URL input from the UI — runs are started by selecting a registered Repository plus an issue number.

## Runtime routing

Phases reference `AgentProfile`s declared in `.ai-orchestrator.json`. The `AgentRuntimeRouter` resolves the configured profile at invocation time and dispatches to the adapter registered for that profile's `runtime`. Fallback is a per-phase routing concern declared on `phaseProfiles[phase].fallbackProfile`.

### Ownership of fallback decisions

Fallback routing has two distinct owners, and this split is load-bearing — it keeps the router from quietly turning into a mini-orchestrator:

- **Phase / loop use cases** own _semantic_ fallback decisions. They know phase context, validation-failure category, touched-file count, reviewer-facing-output requirement, and architectural ambiguity. When such a condition is observed, the use case explicitly invokes the configured `fallbackProfile` (or returns a fallback-request to the router).
- **`AgentRuntimeRouter`** owns _mechanical dispatch_: resolving the requested profile to the registered adapter, recording every `AgentInvocation`, and linking a fallback invocation to the invocation it superseded. The router does not interpret phase semantics.
- The router _may_ enforce a small, objective set of adapter-level triggers itself, because they are observable from the adapter return value alone — **timeout, missing required artifact, invalid `result.json`, prompt budget exceeded, contract violation**. Every higher-level trigger (validation-category change, touched-file budget, reviewer-facing output, architectural ambiguity, repeated-failure counts on a Step) must be signalled by the caller.

This boundary is mirrored in the M4-02c story.

Use **Pi / Qwen** when:

- the expected change is ≤ 3 files;
- the rendered context pack is within the profile's `promptBudgetTokens` (≈ 35–40k);
- the task is already planned (plan exists, work is mechanical);
- validation failure is narrow and pre-categorised;
- no architectural judgment is required;
- no reviewer-facing reply is produced.

Use **OpenCode / frontier** when:

- design or architecture is being decided;
- an implementation plan is being written;
- high-context review is needed;
- reviewer-facing replies are being produced;
- Pi/Qwen fails, times out, or violates its prompt budget;
- the context exceeds the local model budget;
- the task becomes ambiguous;
- the touched file count exceeds the budget.

Explicit fallback triggers (escalate from a Pi profile to its `fallbackProfile`), grouped by owner per the section above:

Router-enforced (adapter-level, observable from the return value alone):

- timeout;
- missing required artifact;
- invalid `result.json`;
- prompt / context budget exceeded;
- contract violation.

Use-case-signalled (semantic):

- two consecutive failures from the same profile on the same Step;
- touched files exceed the expected limit declared by the phase;
- validation failure changes category between iterations;
- architectural ambiguity / reviewer-facing output requested.

Routing is never inferred by opaque LLM judgment.

## Consequences

**Positive**

- VPS deployment is supported without becoming SaaS.
- Multiple Repositories can run concurrently without races; the lease table is the source of truth.
- Repo-level locking is enforced at the database layer, not by convention.
- The orchestrator avoids OpenCode lock-in without committing to abstracting every possible runtime.
- Local Qwen via Pi reduces frontier-model cost for bounded tasks; OpenCode remains available for complex work.
- M8's TypeScript executor stays runtime-agnostic — it only depends on `JobQueuePort`, `WorkerLeasePort`, `AgentPort`, `GitPort`, `GitHubPort`, `ValidationPort`, and `ArtifactStore`.
- Every `AgentInvocation` records its profile, runtime, provider, model, prompt path, stdout/stderr paths, timeout, artifacts, result, contract violations, and (when relevant) the failed invocation it is a fallback of.
- **Operational state partitioning**: Jobs, Runs, Workers, leases, events, and artifacts are repository-local operational state. This enables per-repository event audit trails, query isolation, and future per-repo data retention without cross-repo contamination. Each persisted event carries its stable `repoId` bound at insertion time, ensuring unambiguous ownership.

**Negative / costs**

- More upfront abstraction in M3/M4 (Repository, Job, Worker, WorkerLease ports plus the agent runtime layer) before any user-visible benefit.
- More persistence tables and more careful migration ordering.
- Worker lifecycle must be supervised (systemd in VPS mode; the developer console in local mode).
- Lease recovery must be implemented for the case where a Worker crashes mid-Run.
- Git worktree isolation must be strict to keep concurrent Runs from colliding on the repo cache.
- Routing policy adds configuration complexity and must be kept current as new failure modes emerge.
- Legacy data from a shared database must be migrated on first per-repository runtime creation; ambiguous ownership fails closed to prevent data corruption.

## Non-goals

- SaaS or multi-tenant hosting.
- Multi-user RBAC.
- Distributed workers across multiple VPS machines (a single VPS with N local Workers is supported; horizontal scale-out is not).
- Kubernetes deployment.
- Redis / BullMQ / Sidekiq / Temporal initially.
- Automatic GitHub issue discovery.
- Executing against arbitrary, unregistered repositories.
- Supporting every possible agent runtime (the closed set is `opencode` and `pi` until a concrete need adds a third).
- Opaque LLM-based runtime auto-selection.

## Related

- ADR-0001 — Single-tenant orchestrator with hybrid persistence and clean cancellation
- ADR-0003 — Persistence model for runs and artifacts
- ADR-0004 — Agent runtime and invocation contract
- ADR-0005 — Worktree reuse and cancellation safety
- ADR-0007 — Runtime-agnostic AgentPort with explicit OpenCode and Pi adapters
- PRD §8, §10, §11, §12, §15, §20, §22, §29
- `CONTEXT.md` — Repository, Job, Worker, WorkerLease vocabulary
