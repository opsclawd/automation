# AI SDLC Orchestrator

A local-first orchestration system for running, monitoring, debugging, and recovering AI-agent-driven software delivery workflows — from GitHub issue to reviewed pull request.

## Status

This repository is currently in the **architecture and product specification phase**.

The current repo contains planning documents, design decisions, and domain language for the orchestrator. It does not yet contain the production implementation.

## What this project is

AI SDLC Orchestrator is intended to evolve an existing Bash-based AI automation workflow into a structured TypeScript/Node platform with a web UI.

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

This project formalizes that workflow into a local-first orchestrator with explicit state, artifacts, events, failures, and recovery paths.

## Core concepts

| Concept | Meaning |
| --- | --- |
| Run | One end-to-end orchestration attempt for a GitHub issue. |
| Phase | A named major stage inside a Run, such as `plan-design`, `implement`, or `validate`. |
| Step | An ordered sub-unit within a Phase. |
| Loop | A bounded repeated cycle, such as review/fix. |
| Agent Invocation | One call to an AI agent with a prompt, expected artifacts, and a result. |
| Artifact | A persisted file produced or captured during orchestration. |

## Planned architecture

The system is designed as a local-first application using Clean Architecture and lightweight DDD.

```text
React / Next.js UI
  ↓
Node / TypeScript API
  ↓
Run Orchestrator
  ↓
Worker Process
  ↓
Adapters
    ├─ Bash script adapter
    ├─ Agent CLI adapter
    ├─ Git adapter
    ├─ GitHub adapter
    ├─ Validation adapter
    └─ Artifact adapter
  ↓
SQLite + filesystem artifacts
```

### Key architecture decisions

- Local-first, single-machine operation.
- SQLite for structured orchestration state.
- Filesystem storage for prompts, logs, markdown artifacts, diffs, and result payloads.
- `opencode` as the initial and only agent runtime.
- Git worktrees scoped per issue.
- One active Run per GitHub issue.
- Clean cancellation by terminating the agent process and resetting the worktree to the last known-good commit.
- Distributed workers and multi-user SaaS hosting are explicit non-goals for the initial system.

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

After the observable wrapper exists, orchestration should migrate incrementally from Bash to TypeScript:

1. Node wrapper around Bash.
2. Structured event emission.
3. TypeScript agent runner.
4. TypeScript validation runner.
5. Git and GitHub adapters.
6. Review/fix loop.
7. PR review polling job.
8. Implementation task loop.
9. Full issue-to-PR orchestration.

## Repository structure

```text
.
├── CONTEXT.md
├── docs
│   ├── adr
│   │   └── 0001-local-first-orchestrator-architecture.md
│   ├── ai-agent-sdlc-orchestrator-prd.md
│   └── design-decisions-report.md
└── README.md
```

## Documentation

- [`CONTEXT.md`](./CONTEXT.md) — project language, core domain model, relationships, outcome rules, and lifecycle states.
- [`docs/adr/0001-local-first-orchestrator-architecture.md`](./docs/adr/0001-local-first-orchestrator-architecture.md) — architecture decision record for local-first design, persistence, agent execution, cancellation, and distribution boundaries.
- [`docs/ai-agent-sdlc-orchestrator-prd.md`](./docs/ai-agent-sdlc-orchestrator-prd.md) — full product requirements document.
- [`docs/design-decisions-report.md`](./docs/design-decisions-report.md) — resolved design questions and implementation constraints.

## Non-goals

The initial system is not intended to:

- replace GitHub;
- become a general-purpose CI/CD platform;
- become a generic workflow engine;
- support enterprise multi-tenant SaaS hosting;
- support distributed workers;
- support complex RBAC;
- automatically merge PRs;
- abstract over every possible AI agent runtime.

## Current next step

Build the smallest useful vertical slice:

```text
Start run
→ persist run metadata
→ invoke existing Bash script
→ capture logs
→ emit events
→ show run detail
→ display failure report on non-zero exit
```

The project has enough documentation to begin implementation. More planning before that slice exists will create drag, not clarity.
