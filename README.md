# AI SDLC Orchestrator

A single-tenant AI SDLC orchestrator for manually starting issue-to-PR runs across approved GitHub repositories. It runs locally or on a VPS, executes multiple repositories concurrently while enforcing one active worker per repo, and supports interchangeable agent runtime adapters (initially OpenCode and Pi) behind a single `AgentPort` contract.

## Status

M1 (observable wrapper) and M2 (structured events) are **complete**. M3 (domain/application foundation — including the Repository / Job / Worker / WorkerLease seams and the runtime-agnostic agent abstraction) is next. The repo contains the TypeScript orchestrator alongside planning documents.

## What this project is

AI SDLC Orchestrator is a single-tenant local/VPS AI SDLC orchestrator for manually starting issue-to-PR runs across approved GitHub repositories, with observable run state, repo-scoped worker concurrency, runtime-agnostic agent invocations, validation, review/fix loops, PR creation, and PR review handling.

It is not SaaS, not multi-user, not multi-machine, and not a generic workflow engine. Run starts are explicit (user picks a registered repository + issue number); the orchestrator never discovers issues automatically and never executes against an unregistered repository.

The target workflow is:

```text
GitHub issue
→ design
→ implementation plan
→ implementation
→ validation
→ internal review/fix loop
→ PR creation
→ PR review comment handling
→ ready for merge
```

The core product goal is to make AI-generated software delivery **observable, auditable, resumable, and recoverable**.

At any point, the system should be able to answer:

```text
What is running?
What completed?
What failed?
Why did it fail?
What artifacts exist?
What can safely happen next?
```

## Why this exists

The current automation flow is powerful but fragile. Bash scripts currently handle orchestration, GitHub operations, Git worktrees, prompt construction, agent invocation, validation, review loops, PR creation, and recovery behavior.

That creates predictable operational problems:

- failures are hard to diagnose;
- run state is implicit or scattered across files;
- logs and artifacts are difficult to correlate;
- retry/resume behavior is unsafe or unclear;
- agent contract violations are hard to distinguish from normal command failures;
- post-PR review automation is not first-class orchestration state.

This project formalizes that workflow into a single-tenant orchestrator with explicit state, artifacts, events, failures, recovery paths, and repo-scoped concurrency.

## Core concepts

| Concept          | Meaning                                                                              |
| ---------------- | ------------------------------------------------------------------------------------ |
| Repository       | An approved/registered GitHub repository the orchestrator is allowed to run against. |
| Run              | One end-to-end orchestration attempt for a GitHub issue inside one Repository.       |
| Job              | A queued unit of work claimed by a Worker to execute one Run.                        |
| Worker           | A long-lived process that claims Jobs and executes Runs; many may run concurrently.  |
| WorkerLease      | A per-Repository lease held by exactly one Worker for the duration of an active Run. |
| Phase            | A named major stage inside a Run, such as `plan-design`, `implement`, or `validate`. |
| Step             | An ordered sub-unit within a Phase.                                                  |
| Loop             | A bounded repeated cycle, such as review/fix.                                        |
| Agent Invocation | One call to an agent runtime with a prompt, expected artifacts, and a result.        |
| Agent Profile    | A named runtime+model+budgets+timeout config that an invocation runs under.          |
| Artifact         | A persisted file produced or captured during orchestration.                          |

## Planned architecture

The system is designed as a single-tenant application using Clean Architecture and lightweight DDD. The same architecture runs locally on a developer machine or under systemd on a VPS — the only difference is the number of Worker processes.

```text
Browser UI (Next.js)
  ↓
API (Fastify)
  ↓
Job Queue
  ↓
Worker Pool (1..N processes)
  ↓
Repository Lease
  ↓
Run Executor
  ↓
Ports
    ├─ AgentPort
    │    ├─ OpenCodeAgentAdapter
    │    └─ PiAgentAdapter
    ├─ GitHubPort
    ├─ GitPort
    ├─ ValidationPort
    └─ ArtifactStore
  ↓
SQLite (WAL) + filesystem artifacts
```

### Deployment modes

```text
Local mode:
  one API process + one Worker process on the developer machine.

VPS mode:
  one API process + N Worker processes under systemd
  (e.g. ai-orchestrator-api.service, ai-orchestrator-worker@1.service, ...).
  Tailscale-only or Cloudflare Access access is recommended.
  Single approved GitHub identity / token / app installation.
  No public unauthenticated dashboard.
```

The local/VPS distinction is a deployment concern only. The orchestrator itself is the same single-tenant single-machine process group in both modes; multi-machine workers are not supported.

### Key architecture decisions

- Single-tenant, single-user. May run locally or on one VPS.
- Manual run start by registered Repository + GitHub issue number — no automatic issue discovery, no arbitrary repo URL execution.
- Repository registry: only approved repositories may host Runs.
- Repo-scoped concurrency: multiple Repositories may execute concurrently, but only **one active Worker per Repository** at any moment (enforced by a `WorkerLease`).
- One active Run per (Repository, Issue) pair.
- SQLite (WAL mode) for structured orchestration state, including the job queue and worker-lease tables. Postgres is a future-only consideration triggered by multi-VPS, heavy write contention, or HA — not adopted now.
- Filesystem storage for prompts, logs, markdown artifacts, diffs, and result payloads. Repo caches and run artifacts are kept in separate directories.
- Runtime-agnostic agent invocation behind a single `AgentPort`.
- `OpenCodeAgentAdapter` is the frontier-model runtime — design, planning, high-context review, and PR-comment handling default to it.
- `PiAgentAdapter` is the local small-model runtime (e.g. Qwen 3.6 27B with a 64k context limit) for bounded mechanical work; explicit fallback to OpenCode is configured per phase.
- Runtime/model selection is config-driven (per phase profile), auditable, and fallback-capable — never inferred by opaque LLM judgment.
- Git worktrees scoped per (Repository, Issue, Run). No shared mutable checkout across concurrent Runs.
- Clean cancellation by terminating the agent process, resetting the worktree to the last known-good commit, and releasing the repo lease.
- Multi-machine distributed workers, multi-user SaaS hosting, RBAC, automatic issue discovery, and generic workflow engines are explicit non-goals.

## Planned lifecycle states

```text
RUNNING   Active work in progress.
READY     All reviews addressed; awaiting merge. Not terminal.
SUCCESS   PR merged. Terminal.
FAILED    Unrecoverable failure or loop exhaustion. Terminal.
CANCELLED User-cancelled or timed out. Terminal.
```

## Planned MVP

The first practical implementation target is not a full rewrite. The MVP should wrap the existing Bash automation and make it observable.

MVP capabilities:

- start an issue-to-PR run;
- create a unique run ID;
- create a run directory;
- invoke the existing Bash script;
- capture stdout and stderr;
- persist structured run metadata;
- emit structured events;
- show run list and run detail views;
- display phase timeline;
- expose logs and artifacts;
- classify failures;
- provide basic retry/resume guidance;
- show PR review polling status when applicable.

## Future direction

After the observable wrapper exists, orchestration should migrate incrementally from Bash to TypeScript, with runtime interchangeability and VPS-ready worker concurrency introduced as controlled architecture seams — not new product directions. The intended order is observability first, clean seams second, runtime adapters third, full TypeScript orchestration last:

1. Node wrapper around Bash. **(M1 complete)**
2. Structured event emission. **(M2 complete)**
3. Domain/application foundation: `Repository`, `Job`, `Worker`, `WorkerLease`, `Run`, `Phase`, `AgentProfile`, runtime-agnostic `AgentPort`. **(M3, next)**
4. TypeScript agent runtime layer: `AgentRuntimeRouter`, `OpenCodeAgentAdapter`, `PiAgentAdapter`, prompt rendering, contract validation, result schemas, and phase-profile fallback.
5. TypeScript validation runner.
6. Managed PR review polling, running on the same worker/lease primitives.
7. TypeScript review/fix loop.
8. Full TypeScript phase orchestration, driven by Workers that claim Jobs, acquire repo leases, and call `AgentPort.invoke(...)`.

## Quickstart

See [`docs/quickstart.md`](./docs/quickstart.md) for installation, starting the API/UI, and triggering a run via the `orchestrator` CLI.

## Documentation

- [`CONTEXT.md`](./CONTEXT.md) — project language, core domain model, relationships, outcome rules, and lifecycle states.
- [`docs/adr/0001-local-first-orchestrator-architecture.md`](./docs/adr/0001-local-first-orchestrator-architecture.md) — architecture decision record for local-first design, persistence, agent execution, cancellation, and distribution boundaries.
- [`docs/prd.md`](./docs/prd.md) — full product requirements document.
- [`docs/design-decisions-report.md`](./docs/design-decisions-report.md) — resolved design questions and implementation constraints.

## Non-goals

The initial system is not intended to:

- replace GitHub;
- become a general-purpose CI/CD platform;
- become a generic workflow engine;
- support enterprise multi-tenant SaaS hosting;
- support distributed workers across multiple machines (a single VPS running multiple worker processes is supported; horizontal scale-out across many machines is not);
- support multi-user RBAC;
- automatically discover or open GitHub issues;
- execute against arbitrary, unregistered GitHub repositories;
- automatically merge PRs;
- abstract over every possible AI agent runtime (we support a small, explicit, configured set — currently `opencode` and `pi`);
- auto-select runtimes by opaque LLM judgment — routing is driven by declared phase profiles and explicit fallback rules.

## Repository layout

```text
apps/
  api/        Fastify HTTP API + `orchestrator` CLI
  web/        Next.js dashboard (run list, run detail, logs, artifacts)
packages/
  shared/     config schema, run identity, event schemas
  domain/     pure types: Run, Phase, Failure, Artifact
  application/ use cases (StartIssueRun)
  infrastructure/ SQLite repositories, RunDirectory, Bash wrapper, failure classifier
scripts/
  ai-run-issue-v2       legacy Bash orchestrator (still authoritative in M1)
  ai-pr-review-poll     legacy PR review poller
  ai-consolidate-compound  milestone consolidation pass over `ai/issues/*/compound.md` and `ai/poll-pr-*/compound-*.md`. Run manually after a milestone closes. `--dry-run` to preview, `--since <ref>` or `--issues N,M` to scope.
```
