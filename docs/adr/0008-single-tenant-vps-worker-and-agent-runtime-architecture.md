# Single-tenant VPS worker pool and runtime-agnostic agent adapter architecture

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

## Filesystem layout (VPS)

```text
/var/lib/ai-orchestrator/
  repos/
    owner__repo/
      bare.git/
      worktrees/
        issue-123-run-<runId>/
  runs/
    <runId>/
      prompts/
      logs/
      artifacts/
      diffs/
  orchestrator.sqlite
```

Rules:

- No shared mutable checkout across concurrent Runs.
- One active worktree per repo lease.
- Completed worktrees may be cleaned or archived.
- Artifacts remain under the run directory; the repo cache and run artifacts are kept in separate trees.

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

Explicit fallback triggers (router auto-escalates from a Pi profile to its `fallbackProfile`):

- two consecutive failures from the same profile on the same Step;
- timeout;
- missing required artifact;
- invalid `result.json`;
- contract violation;
- context budget exceeded;
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

**Negative / costs**

- More upfront abstraction in M3/M4 (Repository, Job, Worker, WorkerLease ports plus the agent runtime layer) before any user-visible benefit.
- More persistence tables and more careful migration ordering.
- Worker lifecycle must be supervised (systemd in VPS mode; the developer console in local mode).
- Lease recovery must be implemented for the case where a Worker crashes mid-Run.
- Git worktree isolation must be strict to keep concurrent Runs from colliding on the repo cache.
- Routing policy adds configuration complexity and must be kept current as new failure modes emerge.

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
