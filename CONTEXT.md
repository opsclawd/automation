# AI SDLC Orchestrator

A local-first system that orchestrates AI agents through software development lifecycle phases — from GitHub issue to merged pull request.

## Language

**Run**:
A single end-to-end orchestration attempt for one GitHub issue, identified by UUID.
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

- A **Run** is identified by UUID and scoped to exactly one GitHub issue
- Only one active **Run** may exist per issue at a time (invariant)
- A **Run** progresses through an ordered sequence of **Phases**
- A **Phase** contains zero or more **Steps** (ordered)
- A **Phase** or **Step** may contain a **Loop** (bounded iteration)
- A **Step** groups one or more **Agent Invocations**
- An **Agent Invocation** is validated immediately upon completion; missing artifacts or unparseable results are treated as FAILED outcome
- The orchestrator owns state, policy, contracts, validation, retry/resume, and failure classification. **Agent Runtimes** only execute agent processes — they do not decide phase progression or retry policy

## Outcome rules

- A **Step** is binary: SUCCESS or FAILED
- A **Phase** may be PARTIAL (some Steps completed, some not)
- PARTIAL at Phase level is the natural expression of "resume from failed Step"
- A **Loop** that exhausts its max iterations marks the enclosing Step/Phase as FAILED; the Run stops and awaits user intervention (retry, adjust, or cancel)

## Run lifecycle states

- **RUNNING**: Active work in progress
- **READY**: All reviews addressed, awaiting merge. Not terminal — new review activity reactivates into RUNNING. Subject to global timeout (→ CANCELLED).
- **SUCCESS**: PR merged. Terminal.
- **FAILED**: Unrecoverable failure or loop exhaustion. Terminal. Awaits user intervention.
- **CANCELLED**: User-cancelled or timeout. Terminal.

## Flagged ambiguities

- (none yet)
