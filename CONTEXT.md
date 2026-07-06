# AI SDLC Orchestrator

A single-tenant system that orchestrates AI agents through software development lifecycle phases — from GitHub issue to merged pull request — for approved GitHub repositories. The same system runs locally or on a VPS; the only deployment difference is the number of Worker processes.

## Language

**Repository**:
An approved/registered GitHub repository the orchestrator is allowed to run against. Identified by an internal `RepositoryId` and the `owner/name` pair. Each Repository carries its `defaultBranch`, a `localBasePath` for cached checkouts and worktrees, an `enabled` flag, and `maxConcurrentRuns` (currently fixed at 1 per repo).
_Avoid_: Project, target repo, source repo

**Job**:
A queued unit of orchestration work that a Worker claims in order to execute exactly one Run. Manual run start creates a queued Job; the API never executes the pipeline inline. Jobs progress through `queued → claimed → running → succeeded | failed | cancelled` and carry `runId`, `repoId`, `issueNumber`, `priority`, `attempts`, and `claimedBy`.
_Avoid_: Task, work item

**Worker**:
A long-lived process that claims Jobs and executes Runs. A Worker has a `WorkerId`, hostname, pid, status (`idle | busy | stopping | unhealthy`), and a heartbeat timestamp. The local deployment runs one Worker; a VPS deployment runs N Workers under systemd. A Worker processes at most one Job at a time. Many Workers may operate concurrently on different Repositories; only one may operate on a given Repository.
_Avoid_: Agent, runner, executor (those are reserved for runtime adapters / phase code)

**WorkerLease**:
A per-Repository lease held by exactly one Worker for the duration of an active Run. A Worker MUST acquire a WorkerLease before preparing a worktree or executing a Run. The lease records `repoId`, `workerId`, `runId`, `acquiredAt`, `heartbeatAt`, `expiresAt`. Repository uniqueness is the core invariant; expired leases (no heartbeat) may be reclaimed after safety checks; cancellation releases the lease and resets the worktree.
_Avoid_: Lock, mutex, semaphore

**Run**:
A single end-to-end orchestration attempt for one GitHub issue inside one Repository, identified by UUID.
_Avoid_: Job, execution, session

**Phase**:
A named stage within a Run (e.g. plan-design, implement, validate).
_Avoid_: Stage

**Step**:
An ordered sub-unit within a Phase that groups related Agent Invocations (e.g. one task within the implement Phase).
_Avoid_: Task (overloaded with GitHub issues)

**Loop**:
A repeated cycle within a Phase or Step (e.g. review + fix, up to a max iteration count).
_Avoid_: Retry, cycle

**Agent Invocation**:
A single, runtime-agnostic call to an AI agent with a prompt, producing artifacts and a result. An invocation may be executed by any configured agent runtime adapter (e.g. OpenCode, Pi). Each invocation records its selected profile, runtime, provider/model, prompt path, stdout/stderr paths, timeout, artifacts, result, and any agent contract violations.
_Avoid_: Call, request, execution

**Agent Runtime**:
A concrete adapter that executes an Agent Invocation. The initial runtimes are `opencode` (frontier-model harness) and `pi` (local small-model harness, e.g. Qwen). Runtimes are interchangeable behind the `AgentPort` contract.
_Avoid_: Backend, engine, executor

**Agent Profile**:
A named configuration consumed by `AgentPort`: runtime, provider, model, context/prompt/output budgets, and timeout. Phases reference profiles, not runtimes directly. Fallback is a separate, per-phase _routing_ concern declared on `phaseProfiles` entries (see PRD §15.7) — it is **not** a property of an `AgentProfile`.
_Avoid_: Preset, model config

**Artifact**:
A file produced by an Agent Invocation that persists on the filesystem.
_Avoid_: Output, result file

## Relationships

- A **Repository** may have many **Runs** over time
- A **Run** is identified by UUID and scoped to exactly one **Repository** and one GitHub issue
- Only one active **Run** may exist per (Repository, Issue) pair at a time (invariant)
- Only one active **WorkerLease** may exist per **Repository** at a time (invariant)
- Manual run start enqueues a **Job**; the API never runs the pipeline inline
- A **Worker** claims one **Job** at a time and, before doing any work, acquires the **WorkerLease** for that Job's **Repository**
- Multiple **Workers** may process **Jobs** for different **Repositories** concurrently
- A **Run** progresses through an ordered sequence of **Phases**
- A **Phase** contains zero or more **Steps** (ordered)
- A **Phase** or **Step** may contain a **Loop** (bounded iteration)
- A **Step** groups one or more **Agent Invocations**
- An **Agent Invocation** is executed through exactly one **Agent Profile**, which resolves to exactly one **Agent Runtime** adapter
- An **Agent Invocation** is validated immediately upon completion; missing artifacts or unparseable results are treated as FAILED outcome
- The orchestrator owns state, policy, contracts, validation, retry/resume, failure classification, lease management, and runtime routing. **Agent Runtimes** only execute agent processes — they do not decide phase progression, retry policy, or runtime selection

## Outcome rules

- A **Step** is binary: SUCCESS or FAILED
- A **Phase** may be PARTIAL (some Steps completed, some not)
- PARTIAL at Phase level is the natural expression of "resume from failed Step"
- A **Loop** that exhausts its max iterations marks the enclosing Step/Phase as FAILED; the Run stops and awaits user intervention (retry, adjust, or cancel)

## Run lifecycle states

- **RUNNING**: Active work in progress
- **WAITING (READY)**: All reviews addressed, awaiting merge. Not terminal — new review activity reactivates into RUNNING. Subject to global timeout (→ CANCELLED).
- **NEEDS_HUMAN_REVIEW**: Blocked by a human gate or unrecoverable error requiring manual fix.
- **SUCCESS**: PR merged. Terminal.
- **FAILED**: Unrecoverable failure or loop exhaustion. Terminal. Awaits user intervention.
- **CANCELLED**: User-cancelled or timeout. Terminal.

## Flagged ambiguities

- (none yet)
