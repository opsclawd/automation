# AI SDLC Orchestrator

AI SDLC Orchestrator is a single-tenant AI software delivery control plane. A user explicitly enqueues an approved GitHub issue, then the orchestrator drives it through a configurable issue-to-reviewed-PR pipeline with phase-specific agent/model profiles, durable state, artifacts, logs, validation gates, review/fix loops, and retry/resume controls.

It runs locally or on a VPS, executes multiple repositories concurrently while enforcing one active worker per repository, and supports interchangeable agent runtime adapters (OpenCode, Pi, Antigravity, Claude Code, and Codex) behind a single `AgentPort` contract.

## Status

Milestones **M1 through M8 are complete**. The system is a fully-functional TypeScript-based orchestrator that has superseded the original Bash-based prototype.

## What this project is

AI SDLC Orchestrator is a single-tenant local/VPS AI SDLC control plane for turning approved GitHub issues into reviewed pull requests. It provides observable run state, repo-scoped worker concurrency, runtime-agnostic agent invocations, validation, internal review/fix loops, PR creation, and PR review comment handling.

The operating model is **manual enqueue, autonomous execution**. Run starts are explicit: the user picks a registered repository and GitHub issue number. After that, the orchestrator owns the phase pipeline until the run reaches `READY`, `SUCCESS`, `FAILED`, `CANCELLED`, or a human-review gate.

It is not SaaS, not multi-user, not multi-machine, and not a generic workflow engine. The orchestrator never discovers issues automatically and never executes against an unregistered repository.

The target workflow is:

```text
GitHub issue
→ read_issue
→ plan-design
→ plan-write
→ implement
→ validate
→ fix-validate
→ review-fix
→ compound
→ create-pr
→ post-pr-review
→ ready for merge
```

The core product goal is to make AI-generated software delivery **observable, auditable, resumable, recoverable, and review-gated**.

At any point, the system should be able to answer:

```text
What is running?
What completed?
What failed?
Why did it fail?
What artifacts exist?
Which model/runtime/prompt version was used?
Which review gates remain?
What can safely happen next?
```

## Why this exists

The current automation flow is powerful but fragile. Bash scripts were used initially to handle orchestration, but they created operational problems: failures were hard to diagnose, state was implicit, and logs were scattered.

This project formalized that workflow into a TypeScript orchestrator with explicit state, artifacts, events, failures, recovery paths, review gates, and repo-scoped concurrency.

The product is not another coding agent. Agent runtimes execute work; the orchestrator governs the delivery lifecycle around them.

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
| Attempt          | One execution of a Phase or Step, including inputs, outputs, artifacts, and result.  |
| Loop             | A bounded repeated cycle, such as review/fix or fix-validate.                        |
| Review Gate      | A validation, internal review, external review bot, or PR comment gate.              |
| Agent Invocation | One call to an agent runtime with a prompt, expected artifacts, and a result.        |
| Agent Profile    | A named runtime+model+budgets+timeout config that an invocation runs under.          |
| Pipeline Version | The recorded phase sequence, prompts, skills, profiles, validation, and retry rules. |
| Artifact         | A persisted file produced or captured during orchestration.                          |

## Architecture

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
Run Executor (TypeScript)
  ↓
Ports
    ├─ AgentPort
    │    ├─ OpenCodeAgentAdapter
    │    ├─ PiAgentAdapter (Local Qwen)
    │    ├─ AntigravityAdapter
    │    ├─ ClaudeCodeAdapter
    │    └─ CodexAdapter
    ├─ GitHubPort (gh CLI)
    ├─ GitPort (Worktrees)
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
- SQLite (WAL mode) for structured orchestration state, including the job queue and worker-lease tables.
- Filesystem storage for prompts, logs, markdown artifacts, diffs, and result payloads. Repo caches and run artifacts are kept in separate directories.
- Runtime-agnostic agent invocation behind a single `AgentPort`.
- `OpenCodeAgentAdapter` is the frontier-model runtime — design, planning, high-context review, and PR-comment handling default to it.
- `PiAgentAdapter` is the local small-model runtime (e.g. Qwen 3.6 27B) for bounded mechanical work; explicit fallback to OpenCode is configured per phase.
- Runtime/model selection is config-driven (per phase profile), auditable, and fallback-capable.
- Git worktrees scoped per (Repository, Issue, Run). No shared mutable checkout across concurrent Runs.
- Clean cancellation by terminating the agent process, resetting the worktree to the last known-good commit, and releasing the repo lease.

## Lifecycle states

```text
RUNNING             Active work in progress.
WAITING (READY)     All reviews addressed; awaiting merge. Not terminal.
NEEDS_HUMAN_REVIEW  Blocked by a human gate or unrecoverable error requiring manual fix.
SUCCESS             PR merged. Terminal.
FAILED              Unrecoverable failure or loop exhaustion. Terminal.
CANCELLED           User-cancelled or timed out. Terminal.
```

## Cross-Repository Support

The orchestrator supports executing runs against repositories other than the one where the orchestrator itself is installed. This is achieved using the `--target-repo-root` flag.

- **Per-invocation targeting**: You can point a specific `run` at a different local checkout.
- **Single-target server mode**: The current `serve` mode binds to a single repository context at startup. Centralized multi-repository control planes (managing many different remote repos from one dashboard without local checkouts) are currently out of scope.

## Quickstart

See [`docs/quickstart.md`](./docs/quickstart.md) for installation, starting the API/UI, and triggering a run via the `orchestrator` CLI.

## Documentation

- [`CONTEXT.md`](./CONTEXT.md) — project language, core domain model, relationships, outcome rules, and lifecycle states.
- [`docs/quickstart.md`](./docs/quickstart.md) — installation and operational guide.
- [`docs/prd.md`](./docs/prd.md) — product requirements document (historical context).
- [`docs/adr/`](./docs/adr/) — architecture decision records.

## Non-goals

The system is not intended to:

- replace GitHub;
- become a general-purpose CI/CD platform;
- become a generic workflow engine;
- support enterprise multi-tenant SaaS hosting;
- support distributed workers across multiple machines;
- support multi-user RBAC;
- automatically discover or open GitHub issues;
- execute against arbitrary, unregistered GitHub repositories;
- automatically merge PRs.

## Repository layout

```text
apps/
  api/        Fastify HTTP API + `orchestrator` CLI
  web/        Next.js dashboard (run list, run detail, logs, artifacts)
packages/
  shared/     config schema, run identity, event schemas
  domain/     pure types: Run, Phase, Failure, Artifact
  application/ use cases (StartIssueRun, RunExecutor)
  infrastructure/ SQLite repositories, RunDirectory, adapters (gh, git, agent)
scripts/
  legacy/     deprecated prototypes preserved for reference
```
