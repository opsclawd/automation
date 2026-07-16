# AI SDLC Orchestrator

AI SDLC Orchestrator is a single-tenant control plane for moving approved GitHub issues through an auditable issue-to-reviewed-PR pipeline. It queues work explicitly, runs phase-specific AI agents, persists state and artifacts, enforces validation and review gates, and provides safe resume, cancel, recovery, and merge-readiness controls.

The TypeScript orchestrator is the default and implemented execution path. The M1-M8 milestone arc is complete; the old Bash orchestrator remains available only as an emergency fallback.

## What it does

- Registers the GitHub repositories the control plane may operate on.
- Creates repository-scoped Runs and queued Jobs from explicit issue numbers.
- Schedules work fairly across enabled, healthy repositories.
- Enforces one active WorkerLease per Repository while allowing different repositories to run concurrently.
- Executes a configurable TypeScript phase pipeline through runtime-agnostic agent adapters.
- Records phases, invocations, prompts, logs, validation results, artifacts, failures, review state, and recovery events.
- Serves a Fastify API and browser dashboard with global and repository-specific views.
- Recovers expired claims and leases, reactivates waiting work, and drains workers during graceful shutdown.

The orchestrator governs delivery; agent runtimes only execute individual invocations. Runtime selection and fallback are declared through agent profiles rather than chosen opaquely by an LLM.

## Operating model

The operating model is **manual enqueue, autonomous execution**:

1. An operator registers an approved local checkout.
2. The operator starts a Run for that Repository and GitHub issue.
3. A Job enters the queue.
4. A Worker claims the Job and acquires the Repository's WorkerLease.
5. The TypeScript `RunExecutor` advances through the configured phase pipeline.
6. The Run stops at a terminal state, waits for PR review activity, or reaches a human-review gate.

The system never discovers issues automatically and never executes against an unregistered repository.

## Canonical pipeline

The implemented phase order is:

```text
read_issue
→ plan-design
→ plan-write
→ plan-review
→ implement
→ validate
→ fix-validate
→ review-fix
→ compound
→ create-pr
→ post-pr-review
```

Plan review, implementation review/fix, validation repair, and post-PR review contain bounded internal loops. Configuration may disable only phases explicitly marked skippable.

## Run lifecycle

Persisted Run statuses are:

| Status               | Meaning                                                              |
| -------------------- | -------------------------------------------------------------------- |
| `queued`             | A Job exists but execution has not started.                          |
| `running`            | A Worker is actively advancing the Run.                              |
| `waiting`            | The Run is waiting for external PR review activity.                  |
| `blocked`            | Progress requires an external condition or explicit operator action. |
| `needs_human_review` | An automated review/fix path exhausted its safe policy.              |
| `passed`             | The Run completed successfully. Terminal.                            |
| `failed`             | The Run ended unsuccessfully. Terminal.                              |
| `cancelled`          | The operator or shutdown policy cancelled the Run. Terminal.         |

Only `passed`, `failed`, and `cancelled` are terminal domain states. A waiting or blocked Run may be resumed or reactivated.

## Implemented architecture

```text
Browser dashboard
        │
        ▼
Fastify API / CLI ───── Repository registry
        │
        ▼
Fair repository scheduler
        │
        ▼
SQLite Job claim ──► WorkerLease ──► repository worktree
        │
        ▼
TypeScript RunExecutor
        │
        ├── AgentPort ──► OpenCode / Pi / Antigravity / Claude Code / Codex adapters
        ├── GitHubPort
        ├── GitPort
        ├── ValidationPort
        └── ArtifactStore
```

The code follows inward-only Clean Architecture dependencies:

```text
shared  ←  domain  ←  application  ←  apps/api
                              ↑
                    infrastructure  ←  apps/api
```

`apps/api` is the composition root. Domain code is pure; application use cases depend on ports; infrastructure supplies adapters.

## Multi-repository scheduling

One control-plane process can list, inspect, and operate all enabled registered repositories. The scheduler visits repositories using a stable round-robin cursor so sustained work in one repository does not starve another.

- `scheduler.globalConcurrency` limits in-flight dispatches in one scheduler process.
- A Repository may have only one active WorkerLease, regardless of the global limit.
- Disabled repositories accept no new work; already admitted work drains.
- Unhealthy or unavailable repositories are skipped without blocking healthy repositories.
- Claims and leases use ownership tokens and generation fencing to reject stale workers.
- Startup recovery runs before new admission.
- Graceful shutdown stops admission, drains cooperative work, and leaves non-cooperative ownership for fenced expiry/recovery.

The global counter is process-local. Multiple coordinators do not share one global concurrency counter.

## Deployment boundary

The supported topology is single-tenant and **single host**:

- Local: one API/control-plane process with its scheduler.
- VPS: one API/control-plane process, optionally with additional local Worker processes supervised on the same machine.

Workers on different machines are not supported. Recovery relies on same-host PID and hostname checks, and the SQLite topology assumes shared local filesystem access. Each scheduler process applies its own global concurrency limit; Repository leases remain the cross-process serialization boundary.

## Quickstart

Requirements: Node 22+, pnpm 9+, an authenticated `gh` CLI, and a valid `.ai-orchestrator.json`.

```bash
corepack enable
pnpm install

# Terminal 1: API with embedded scheduler/worker pool
pnpm --filter @ai-sdlc/api dev serve

# Terminal 2: dashboard
pnpm --filter @ai-sdlc/web dev
```

Register a checkout and start a TypeScript Run:

```bash
pnpm --filter @ai-sdlc/api dev repo register --local-path /absolute/path/to/repo
pnpm --filter @ai-sdlc/api dev repo list
pnpm --filter @ai-sdlc/api dev run \
  --repository-id owner/repo \
  --target-repo-root /absolute/path/to/repo \
  --issue 123
```

See the [operator quickstart](docs/quickstart.md) for repository management, worker modes, configuration, logs, resume/cancel/execute commands, API/dashboard workflows, and recovery.

## Configuration

`.ai-orchestrator.json` defines validation, phase policy, scheduler settings, timeouts, agent profiles, and per-phase routing. `.ai-orchestrator.local.json` supplies ignored local overrides. For cross-repository runs, the automation configuration is layered with the selected target repository's committed and local configuration.

Agent profiles declare a runtime, provider, model, budgets, and timeout. Phase-profile entries select primary and fallback profiles plus objective fallback triggers. See [Configuration](docs/quickstart.md#configuration) and the schema in [`packages/shared/src/config/schema.ts`](packages/shared/src/config/schema.ts).

## State and artifacts

The default single-repository CLI path keeps its database and run artifacts under the selected repository's `.ai-runs/` directory and its active worktree at `.ai-worktrees/issue-<N>`.

Centralized repository runtimes additionally namespace mutable state by `owner/name` under the configured state root so two repositories with the same issue number cannot collide. Exact control-plane, repository-runtime, artifact, temporary, and worktree paths are documented in the [operator quickstart](docs/quickstart.md#state-artifacts-and-worktrees).

Completed durable issue artifacts are archived under `ai/issues/<N>/` when the pipeline produces them.

## Legacy Bash fallback

The TypeScript executor is the default:

```bash
pnpm --filter @ai-sdlc/api dev run \
  --repository-id owner/repo \
  --target-repo-root /absolute/path/to/repo \
  --issue 123
```

The quarantined Bash path is retained for emergency use only:

```bash
pnpm --filter @ai-sdlc/api dev run \
  --repository-id owner/repo \
  --target-repo-root /absolute/path/to/repo \
  --issue 123 \
  --executor bash
```

The Bash-specific `--model`, `--agent-cli`, and `--script` flags are rejected or ignored by the TypeScript path as documented in CLI help. The legacy scripts are not the source of truth for new behavior.

## Repository layout

```text
apps/
  api/             Fastify API, orchestrator CLI, and composition root
  cli/             focused CLI utilities
  web/             browser operations dashboard
packages/
  shared/          configuration, identifiers, and event schemas
  domain/          pure domain types and invariants
  application/     use cases, ports, phase handlers, and executor policy
  infrastructure/  SQLite, Git, GitHub, validation, process, and agent adapters
scripts/
  legacy/          deprecated Bash orchestrator and poller
  lib/__tests__/   Bash parity and shell regression tests
```

## Documentation

- [`CONTEXT.md`](CONTEXT.md) — canonical vocabulary, relationships, and lifecycle rules.
- [`docs/quickstart.md`](docs/quickstart.md) — installation and operator workflows.
- [`docs/operations/scheduler-recovery.md`](docs/operations/scheduler-recovery.md) — recovery state machine and procedures.
- [`docs/product-direction.md`](docs/product-direction.md) — living product thesis and priorities.
- [`docs/adr/`](docs/adr/) — accepted architecture decisions.
- [`docs/prd.md`](docs/prd.md) and [`docs/milestone-stories.md`](docs/milestone-stories.md) — historical planning archives.

## Non-goals

- Multi-tenant SaaS hosting or multi-user RBAC.
- Distributed workers across multiple machines.
- Kubernetes-native autoscaling or a generic distributed job system.
- Automatic GitHub issue discovery or automatic PR merge.
- Concurrent Runs inside one Repository.
- Arbitrary unregistered repository execution.
- Opaque LLM-selected runtime routing.
- A general-purpose workflow engine or CI/CD replacement.
