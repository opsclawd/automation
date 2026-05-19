# AI SDLC Orchestrator — Milestone Stories

**Status:** M1 and M2 complete. M3 next — introduces the runtime-agnostic agent abstraction. M4+ are planned.
**Generated:** 2026-05-13
**Source PRD:** [`prd.md`](./prd.md) §29 Milestones
**Companion docs:** [`design-decisions-report.md`](./design-decisions-report.md), [`adr/0001-local-first-orchestrator-architecture.md`](./adr/0001-local-first-orchestrator-architecture.md)

This document enumerates every GitHub issue needed to complete Milestones M1–M8. Each story is sized to be implementable in one PR by a single contributor (human or agent). Stories are grouped by milestone and ordered by dependency.

---

## How to read a story

```text
ID            Stable identifier used for cross-references.
Title         Issue title — paste verbatim into GitHub.
Labels        Milestone + area labels.
Depends on    Other story IDs that must merge first.
User story    "As a … I want … so that …" framing.
Context       Why the story exists. Pointers into PRD/ADR/scripts.
Scope         What is in-scope. Explicit boundaries.
Out of scope  What this story will not do.
Acceptance    Verifiable acceptance criteria.
Artifacts     Files / endpoints / tables created or changed.
Test plan     How acceptance is verified.
```

---

## Cross-cutting conventions

- **Repo layout (target):** `apps/web`, `apps/api`, `apps/worker`, `packages/domain`, `packages/application`, `packages/infrastructure`, `packages/shared`. MVP may collapse `apps/api` + `apps/worker` into one Node process.
- **Language:** TypeScript with strict mode for new code. Existing Bash scripts in `scripts/` remain authoritative until M8.
- **Persistence:** SQLite via better-sqlite3 (sync, embedded). Filesystem artifacts under `.ai-runs/<runId>/` and `.ai/` inside the worktree (per Q15).
- **Runtime config:** `.ai-orchestrator.json` at repo root (per Q26). Operational config via env (`AI_MODEL`, `AI_RUNTIME`).
- **Domain vocabulary:** Run, Phase, Step, Loop, Agent Invocation, Artifact (per `CONTEXT.md`).
- **Definition of done (every story):**
  - Code merged to `main` with green CI.
  - Unit tests for any domain/application code.
  - Updated docs where applicable (`README.md`, ADR, or skill).
  - No regression in the existing Bash scripts unless explicitly replaced.

---

# Milestone M1 — Observable Bash Wrapper — **Complete**

**Goal:** Make the existing scripts observable without changing their orchestration logic. After M1, every run produces a stable run directory, persisted metadata, captured stdout/stderr, a structured failure file, and a minimal UI to inspect it.

**Note:** M1 is complete. Stories below are kept for historical reference and dependency tracking. Do not re-plan M1 scope. M1 does not own agent-runtime metadata; if events happen to carry runtime/model labels, they are pass-through values.

## M1-01 — Bootstrap monorepo + tooling

- **Labels:** `milestone:M1`, `area:infra`
- **Depends on:** —
- **User story:** As a maintainer, I want a TypeScript monorepo skeleton so that subsequent stories have a consistent home for code, tests, and tooling.
- **Context:** PRD §13.1 recommends `apps/*` + `packages/*`. Start with the lighter `src/` layout from §13.1 (`domain`, `application`, `infrastructure`, `interfaces`) but use pnpm workspaces so we can split later without churn.
- **Scope:**
  - `pnpm` workspace with `apps/web`, `apps/api`, `packages/domain`, `packages/application`, `packages/infrastructure`, `packages/shared`.
  - TypeScript 5.x strict, ESLint, Prettier, Vitest configured at root.
  - CI workflow (`.github/workflows/ci.yml`) running install + build + test + lint.
  - `.editorconfig`, `.nvmrc` (Node 22 LTS), `pnpm-lock.yaml` committed.
- **Out of scope:** Any application code. Web UI scaffolding (separate story).
- **Acceptance:**
  - `pnpm install && pnpm -r build && pnpm -r test && pnpm -r lint` passes in CI on a clean checkout.
  - Each package exports an empty index and has a passing placeholder test.
- **Artifacts:** root `package.json`, `tsconfig.base.json`, `pnpm-workspace.yaml`.
- **Test plan:** CI green.

## M1-02 — Define `.ai-orchestrator.json` schema and loader

- **Labels:** `milestone:M1`, `area:config`
- **Depends on:** M1-01
- **User story:** As an automation owner, I want a single declarative config so the orchestrator knows validation commands, skip-list, and timeouts.
- **Context:** Q22, Q26, Q34. Config drives validation and timeouts; orchestrator must fail fast if missing.
- **Scope:**
  - Zod schema in `packages/shared` matching the Q26 shape (`validation.commands`, `validation.timeout`, `phases.skip`, `phases.reviewFix.maxIterations`, `phases.implement.maxIterations`, `timeouts.readyMaxDays`, `timeouts.invocationMaxMinutes`).
  - `loadConfig(repoRoot)` helper that reads, parses, validates, and returns a typed object. Throws a typed `ConfigError` on missing/invalid file.
  - Sample `.ai-orchestrator.json` committed at repo root with the values from Q26.
- **Out of scope:** Wiring config into runners (later stories).
- **Acceptance:**
  - Valid config parses; invalid config produces a precise error path (e.g. `validation.timeout must be a positive integer`).
  - Missing config throws `ConfigError` with remediation message.
- **Test plan:** Unit tests covering valid/invalid/missing.

## M1-03 — Run identity + directory layout

- **Labels:** `milestone:M1`, `area:domain`, `area:infra`
- **Depends on:** M1-01
- **User story:** As an automation owner, I want every run to have a stable ID and on-disk home so I can find logs and artifacts later.
- **Context:** PRD §22.1, Q1, Q15. Run directory under `.ai-runs/<runId>/`. Run ID convention: `issue-<N>-<YYYYMMDD>-<HHMMSS>` (matches existing Bash output) plus an internal UUID for DB key.
- **Scope:**
  - `Run` domain type with `id` (UUID), `displayId` (human-readable), `issueNumber`, `type`, `status`, `currentPhase`, timestamps.
  - `RunDirectory` infrastructure helper that creates `.ai-runs/<displayId>/{phases,artifacts}` and writes `run.json`.
  - Atomic write + `fsync` semantics for `run.json` to survive crash mid-write.
- **Acceptance:**
  - Calling `createRun(...)` produces a directory with the expected structure and a valid `run.json`.
  - Two concurrent `createRun` calls for the same issue refuse the second (domain invariant Q1).
- **Test plan:** Unit tests against a temp dir.

## M1-04 — SQLite repository for Runs / Phases / Events

- **Labels:** `milestone:M1`, `area:infra`, `area:persistence`
- **Depends on:** M1-03
- **User story:** As an automation owner, I want orchestration metadata in SQLite so the UI can query quickly without parsing files.
- **Context:** Q12 hybrid: mutable status columns + append-only `events` table. PRD §20.1.
- **Scope:**
  - `better-sqlite3` dependency. DB file at `.ai-runs/orchestrator.sqlite`.
  - Migration framework (sqlite-migrations or hand-rolled `init.sql`).
  - Tables for MVP: `runs`, `phases`, `events`, `artifacts`, `failures`.
  - `RunRepository`, `PhaseRepository`, `EventRepository`, `ArtifactRepository`, `FailureRepository` ports + SQLite adapters.
  - Indices on `runs(issueNumber, status)`, `events(runId, timestamp)`, `phases(runId, name)`.
- **Out of scope:** PR review tables (M6).
- **Acceptance:**
  - Schema applies cleanly on fresh DB; idempotent re-run.
  - Round-trip create/read/update/list works for each repo.
- **Test plan:** Integration tests against a temp `:memory:` DB and a temp file DB.

## M1-05 — Node Bash wrapper CLI: `orchestrator run --issue <N>`

- **Labels:** `milestone:M1`, `area:cli`, `area:infra`
- **Depends on:** M1-02, M1-03, M1-04
- **User story:** As an automation owner, I want to start the existing Bash script through a Node CLI so that runs are registered in the DB and on disk.
- **Context:** PRD §16.2.1, §29 M1. Wrap `scripts/ai-run-issue-v2`. Use the legacy script unchanged.
- **Scope:**
  - `apps/api` (or `apps/cli`) exposes `orchestrator run --issue <N> [--base-branch main] [--model ...]`.
  - On run start: creates Run row + run directory, spawns `scripts/ai-run-issue-v2` with appropriate env, streams stdout/stderr.
  - Captures stdout → `stdout.log`, stderr → `stderr.log`, combined → `combined.log`.
  - Records final exit code and duration in DB.
  - Sets `status` to `running`, then `passed` / `failed` based on exit.
- **Out of scope:** Phase-level events (M2). UI (M1-07).
- **Acceptance:**
  - Running `orchestrator run --issue 123` against a stub script produces `run.json`, `stdout.log`, `stderr.log`, and updates DB.
  - Killing the process mid-run leaves a `failed` run with non-zero exit code recorded.
- **Test plan:** Integration test using a fake `scripts/ai-run-issue-v2` that prints to both streams and exits with controllable code.

## M1-06 — Failure classifier (best-effort) for wrapped Bash output

- **Labels:** `milestone:M1`, `area:application`
- **Depends on:** M1-05
- **User story:** As an automation owner, I want a `failure.json` per failed run so I see _what_ failed without reading raw logs.
- **Context:** PRD §25 failure categories. In M1 we can only classify from exit code + log heuristics (the Bash script's own `orchestrator_fail` messages); richer signals arrive in M2.
- **Scope:**
  - On non-zero exit: scan `combined.log` for known sentinels (e.g. `orchestrator_fail`, `MISSING ARTIFACT`, `TIMEOUT`, `branch changed`) and emit a `Failure` record with `kind`, `phase` (best-effort from last `LAST_PHASE`), `message`, `canRetry: false`, `suggestedAction`.
  - Write `failure.json` in the run directory.
- **Out of scope:** Structured agent-contract violations (M4).
- **Acceptance:**
  - Stubbed failures producing each known sentinel are classified to the right `kind`.
  - Unknown failures classify as `unknown` with the tail of stderr as message.
- **Test plan:** Table-driven unit tests over sample log fixtures.

## M1-07 — Web UI shell: Run list + Run detail (logs + artifacts)

- **Labels:** `milestone:M1`, `area:ui`
- **Depends on:** M1-04, M1-05
- **User story:** As an automation owner, I want a browser UI showing recent runs and per-run logs so I can debug without `cat`-ing files.
- **Context:** PRD §16.2.2, §16.2.3, §16.2.5, §24.1, §24.2. Use Next.js 15 App Router, shadcn/ui, Tailwind.
- **Scope:**
  - `/` page: paginated table of runs (display ID, issue, status, currentPhase, started, duration, failure summary).
  - `/runs/[id]` page: header + tabs (Logs, Artifacts, Failure). Logs tab streams `combined.log` (initially via polling, SSE in M2). Artifacts tab lists files under the run directory with a viewer for `.md`, `.json`, `.log`, `.diff`.
  - REST endpoints (in `apps/api`):
    - `GET /api/runs`
    - `GET /api/runs/:runId`
    - `GET /api/runs/:runId/artifacts`
    - `GET /api/runs/:runId/artifacts/:path` (path-sanitised file read).
  - Failure tab renders `failure.json` if present.
- **Out of scope:** Phase timeline (M2-04). Retry/Resume buttons (M8). PR review tab (M6).
- **Acceptance:**
  - Starting a run via CLI immediately surfaces it in `/`.
  - Run detail page shows live logs (≤2s polling) and a complete artifact tree after completion.
- **Test plan:** Playwright smoke against a seeded run.

## M1-08 — Documentation pass: how to run the wrapper

- **Labels:** `milestone:M1`, `area:docs`
- **Depends on:** M1-05, M1-07
- **User story:** As a new contributor, I want a README section explaining how to start a wrapped run so I can use the orchestrator on day one.
- **Scope:** Update `README.md` with quickstart (`pnpm install`, `pnpm dev`, `orchestrator run --issue 123`). Document `.ai-orchestrator.json` keys.
- **Acceptance:** A contributor following the README on a clean machine reproduces a passing run against the wrapper.

---

# Milestone M2 — Structured Events in Bash — **Complete**

**Goal:** Make phase progress visible. Bash emits structured events that the orchestrator persists and the UI renders as a timeline.

**Note:** M2 is complete. Stories below are kept for historical reference. M2 stays focused on observable Bash + structured events; runtime/model fields may be emitted in events if available but no runtime abstraction is introduced here.

## M2-01 — Bash `emit_event` helper

- **Labels:** `milestone:M2`, `area:bash`
- **Depends on:** M1-05
- **User story:** As the Bash script, I want a small helper to emit JSON events so the wrapper can build a timeline.
- **Context:** PRD §16.2.4, FR4. Event shape `{ runId, phase, level, message, timestamp, metadata }`.
- **Scope:**
  - Add `scripts/lib/emit_event.sh` with `emit_event <phase> <level> <type> <message> [k=v ...]` that appends a single JSON line to `$EVENTS_FILE` (path passed in by wrapper via env `AI_RUN_EVENTS_FILE`).
  - Strict JSON escaping (use `jq -nc` if available, fallback to a hand-rolled escaper).
  - Source `emit_event.sh` from both legacy scripts.
- **Out of scope:** Replacing existing `log()` (keep both for now).
- **Acceptance:** Each call produces exactly one line of valid JSON in `events.jsonl`.
- **Test plan:** Bash test using bats or shellspec; round-trip with `jq` validates.

## M2-02 — Instrument `ai-run-issue-v2` with phase + artifact events

- **Labels:** `milestone:M2`, `area:bash`
- **Depends on:** M2-01
- **User story:** As an automation owner, I want events for every phase transition and artifact write so the UI can render a real timeline.
- **Scope:** Insert `emit_event` calls at:
  - Run start / run completed.
  - Phase start / phase completed / phase failed (one per `PHASE=` transition listed in the script).
  - Loop iteration start/completed for `fix-review`.
  - Artifact created: `design.md`, `plan.md`, `implementation-log.md`, `validate.log`, `review.md`, `pr-summary.md`, etc.
  - Command started / completed / failed for validation commands.
- **Acceptance:**
  - A full happy-path run produces a chronologically-ordered `events.jsonl` containing at minimum one `phase.started` and `phase.completed` per phase.
  - Failed runs emit a `phase.failed` with the failing command and exit code in `metadata`.
- **Test plan:** Run wrapper against a stub repo and snapshot the event stream.

## M2-03 — Instrument `ai-pr-review-poll` with poll events

- **Labels:** `milestone:M2`, `area:bash`
- **Depends on:** M2-01
- **User story:** As an automation owner, I want poll-level events so I can see what each polling iteration did.
- **Scope:** Events for poll start/end, comment fetch, processed comment count, agent invocation, reply posted, verification result, terminal state.
- **Acceptance:** A 3-poll run yields a complete event trail with one terminal event (`run.completed` or `run.failed`).

## M2-04 — Ingest events into SQLite + SSE stream

- **Labels:** `milestone:M2`, `area:infra`, `area:api`
- **Depends on:** M1-04, M2-02
- **User story:** As the API, I want events persisted to SQLite and broadcast over SSE so the UI updates in real time.
- **Context:** Q35, PRD §23.6.
- **Scope:**
  - Tail `events.jsonl` while the child process runs; for each line, validate against the shared Zod schema and insert into the `events` table.
  - `GET /api/runs/:runId/events?since=<iso>` returns events since the cursor.
  - `GET /api/runs/:runId/events/stream` SSE endpoint that backfills from `since` then streams new rows.
  - Disconnect-safe: reconnect with `?since=` resumes without duplicates.
- **Acceptance:** UI subscribers see new events ≤500 ms after they hit disk.
- **Test plan:** Integration test seeding events, asserting SSE delivery order.

## M2-05 — UI Phase Timeline tab

- **Labels:** `milestone:M2`, `area:ui`
- **Depends on:** M2-04
- **User story:** As an automation owner, I want a visual phase timeline so I can see at a glance where a run is.
- **Context:** PRD §24.2 Timeline, FR6.
- **Scope:**
  - Vertical timeline of canonical phases (`read_issue → … → done`).
  - Pending / running / passed / failed / skipped / blocked visual states.
  - Click → scrolls associated logs and lists phase artifacts.
  - Duration per phase from event timestamps.
- **Acceptance:** Visual smoke matches snapshot for a sample completed run and a sample failed run.

## M2-06 — Failure events enrich `failure.json`

- **Labels:** `milestone:M2`, `area:application`
- **Depends on:** M1-06, M2-04
- **User story:** As an automation owner, I want a richer failure report driven by events, not log scraping.
- **Scope:** Rewrite the classifier to consume the last few events plus the exit code. Use the `phase.failed` event's `metadata` (command, exitCode, missingArtifact) directly. Keep log scraping as a fallback only when no `phase.failed` event was emitted.
- **Acceptance:** Stub failures produce `failure.json` with the same `kind` as the emitting event.

---

# Milestone M3 — Domain / Application Foundation (incl. Agent Runtime Seam)

**Goal:** Establish Clean Architecture + DDD-lite boundaries **and the runtime-agnostic agent abstraction**. No new user-visible behavior. M3 creates the seam; it does not execute Pi or OpenCode yet — M4 implements the adapters.

**Cross-cutting acceptance for M3:**

- `packages/domain` and `packages/application` import no concrete runtime — no `opencode`, no `pi`, no `child_process`, no CLI-specific infrastructure.
- All agent-touching code paths can be exercised end-to-end with fake `AgentPort` implementations.
- Adding the OpenCode and Pi adapters in M4 requires no further changes to domain or application code — only composition-root wiring.

## M3-01 — Domain types and invariants

- **Labels:** `milestone:M3`, `area:domain`
- **Depends on:** M1-01
- **User story:** As a developer, I want pure domain types for Run, Phase, Step, Loop, Agent Invocation, Failure, Artifact, and AgentContract so future code can refer to them without infra leakage.
- **Context:** PRD §15, CONTEXT.md.
- **Scope:**
  - Pure TypeScript in `packages/domain`. No `fs`, no `child_process`, no SQLite imports.
  - State transition functions: `Run.start`, `Run.completePhase`, `Run.fail`, `Run.transitionToReady`, `Run.reactivate`, `Run.cancel`, with explicit guards.
  - Step outcome rule (binary), Phase outcome rule (allows PARTIAL), Loop exhaustion → FAILED.
  - Branded types for `RunId`, `IssueNumber`, `PhaseName`.
  - Pure functions only; no side effects.
- **Acceptance:**
  - Property tests assert: PARTIAL only at phase level; Step transitions are binary; you cannot leave RUNNING for SUCCESS without all required phases passed.
- **Test plan:** Vitest + fast-check.

## M3-02 — Application use case interfaces (no implementations)

- **Labels:** `milestone:M3`, `area:application`
- **Depends on:** M3-01
- **User story:** As a developer, I want use case interfaces declared so M4–M8 can fill them in.
- **Scope:** Types/interfaces only:
  - `StartIssueRun`, `ResumeRun`, `RetryFailedPhase`, `CancelRun`.
  - `RunAgentWithContract`, `RunValidation`, `ProcessPrReviewComments`, `CreatePullRequest`.
- **Acceptance:** Compiles; consumed by tests via fake implementations.

## M3-03 — Ports: Agent, GitHub, Git, ArtifactStore, RunRepository, EventBus

- **Labels:** `milestone:M3`, `area:application`
- **Depends on:** M3-02
- **User story:** As a developer, I want runtime-agnostic ports defined so infrastructure adapters have a contract to implement and no application code depends on a concrete CLI.
- **Context:** PRD §14, §15.7, ADR-0007.
- **Scope:**
  - Interfaces in `packages/application/ports/`.
  - `AgentPort` is **runtime-agnostic** with the shape from PRD §14:
    ```ts
    interface AgentPort {
      invoke(input: AgentInvocationRequest): Promise<AgentInvocationResult>;
    }
    ```
  - Each port has a fake/in-memory implementation in `packages/application/test-doubles/`.
  - The fake `AgentPort` records every invocation request and lets tests script per-profile responses (success, contract violation, timeout, fallback-triggering failure).
- **Acceptance:**
  - Application package builds with no infra imports.
  - No file under `packages/application/` or `packages/domain/` imports `opencode`, `pi`, `child_process`, or any CLI-specific infrastructure.
  - Fakes implement every method.

## M3-03a — AgentRuntimeKind and AgentProfile domain types

- **Labels:** `milestone:M3`, `area:domain`, `area:config`
- **Depends on:** M3-01
- **User story:** As a developer, I want `AgentRuntimeKind` and `AgentProfile` as pure domain types so every later layer can refer to them without leaking a specific CLI.
- **Context:** PRD §15.7, ADR-0007.
- **Scope:**
  - `AgentRuntimeKind = 'opencode' | 'pi'`.
  - `AgentProfile` with fields: `runtime`, `provider`, `model`, optional `contextLimitTokens`, optional `promptBudgetTokens`, optional `outputBudgetTokens`, `timeoutMinutes`. **Fallback is a per-phase routing concern declared on `phaseProfiles` entries (see PRD §15.7) — it is not a property of `AgentProfile`.**
  - Branded `AgentProfileName`.
  - Pure TypeScript in `packages/domain`.
- **Acceptance:** Unit tests for type guards (e.g. `isPiProfile`) and basic validation (e.g. Pi profile with `contextLimitTokens` set, OpenCode profile with `timeoutMinutes` set).

## M3-03b — AgentInvocationRequest / AgentInvocationResult contracts

- **Labels:** `milestone:M3`, `area:application`
- **Depends on:** M3-01, M3-03a
- **User story:** As a developer, I want runtime-agnostic invocation request/result types so phase code and tests can describe an Agent Invocation without naming a runtime.
- **Context:** PRD §14, §15.3, §15.7.
- **Scope:**
  - `AgentInvocationRequest { profile, promptPath, expectedArtifacts, cwd, runId, phaseId, stepId? }`.
  - `AgentInvocationResult { runtime, provider, model, exitCode, durationMs, stdoutPath, stderrPath, resultJsonPath?, contractViolations[], outcome }`.
  - Both shapes live in `packages/application` (or `packages/domain` if pure enough — choose one and document).
- **Acceptance:** Compiles; consumed by the fake `AgentPort` in M3-03; round-trips through composition root in M3-06.

## M3-03c — Agent config schema in `.ai-orchestrator.json`

- **Labels:** `milestone:M3`, `area:config`, `area:shared`
- **Depends on:** M1-02, M3-03a
- **User story:** As an operator, I want a config schema for `agent.profiles` and `agent.phaseProfiles` so I can declare runtimes per phase before any adapter ships.
- **Context:** PRD §15.7. Specific provider/model values are configurable examples, not commitments.
- **Scope:**
  - Extend the Zod schema in `packages/shared` with the `agent` section shown in PRD §15.7.
  - `loadConfig` returns a typed `AgentConfig` object including `defaultProfile`, `profiles`, and `phaseProfiles`.
  - Invalid configuration (unknown profile referenced in `phaseProfiles[*].profile`, unknown `runtime`, unknown `phaseProfiles[*].fallbackProfile`) produces a precise `ConfigError`.
  - Sample `.ai-orchestrator.json` committed at repo root includes the example shape; values are illustrative.
- **Out of scope:** Actually executing any runtime.
- **Acceptance:** Valid configs parse; invalid configs (dangling profile refs, unknown runtime) fail with a clear error path.

## M3-04 — Wire existing SQLite adapter to RunRepository port

- **Labels:** `milestone:M3`, `area:infra`
- **Depends on:** M1-04, M3-03
- **User story:** As a developer, I want the M1 SQLite repos to implement the M3 ports so existing code routes through the clean layer.
- **Scope:** Move adapters to `packages/infrastructure`. Update M1 wrapper to depend on ports, not adapters directly. No behavior change.
- **Acceptance:** All M1 tests still pass.

## M3-05 — Bash adapter implements AgentPort + IssueRunPort

- **Labels:** `milestone:M3`, `area:infra`
- **Depends on:** M3-03, M1-05
- **User story:** As a developer, I want the legacy Bash invocation to live behind a port so we can swap pieces out incrementally.
- **Scope:** `BashIssueRunAdapter implements IssueRunPort` and `BashPrReviewPollAdapter implements PrReviewPollPort`. The wrapper from M1-05 now resolves these adapters via the application layer.
- **Acceptance:** Behavior identical; integration tests unchanged.

## M3-06 — Dependency injection / composition root (incl. agent profile resolution)

- **Labels:** `milestone:M3`, `area:infra`
- **Depends on:** M3-04, M3-05, M3-03c
- **User story:** As a developer, I want one place that wires ports → adapters and resolves agent profiles so tests can swap implementations cleanly.
- **Scope:**
  - Single `composeRoot()` factory in `apps/api` returning a typed `Container`. No DI framework — plain factory.
  - The container exposes an `AgentPort` whose implementation is resolved from `agent.profiles[<profileName>].runtime` at invocation time.
  - In M3 the only registered runtime adapter is the fake (test double); real adapters land in M4.
  - The container reads `agent.phaseProfiles` and exposes a `resolveProfileForPhase(phaseName)` helper so phase handlers do not parse config themselves. The helper is a **direct lookup** against the shipped phase-name set (e.g. `review` and `fix-review` as two separate phases until M8 merges them into `review-fix`); an unknown phase name raises a typed `ConfigError`. No legacy-name remapping — see PRD §15.7.
- **Acceptance:**
  - Tests can build a Container with fakes for every port, including an `AgentPort` backed by the in-memory fake.
  - Wiring a real adapter in M4 requires only registering it in the composition root — no domain or application changes.

---

# Milestone M4 — TypeScript Agent Runtime Layer

**Goal:** Centralise every agent call into a single runtime-agnostic layer that captures prompts, stdout/stderr, exit code, timeout, selected profile/runtime/model, validates the agent contract, and supports configured fallback. All agent execution must be auditable through the same `AgentInvocation` record shape regardless of runtime.

## M4-01 — Agent invocation model + DB tables

- **Labels:** `milestone:M4`, `area:domain`, `area:persistence`
- **Depends on:** M3-01, M3-03b, M1-04
- **User story:** As a developer, I want an `AgentInvocation` record persisted per agent call so I can audit prompts and outcomes regardless of which runtime executed the call.
- **Context:** PRD §15.3, §15.7, Q6, Q24, ADR-0007.
- **Scope:**
  - Domain type `AgentInvocation { id, runId, phaseId, stepId?, profile, runtime, provider, model, skill?, promptPath, stdoutPath, stderrPath, startCommitSha, endCommitSha?, exitCode?, durationMs?, timeoutMs, outcome, contractViolations[], resultJsonPath?, fallbackOfInvocationId? }`.
  - `agent_invocations` SQLite table + repository. Columns must include `profile`, `runtime`, `provider`, `model`, `fallback_of_invocation_id`.
  - Index on `(run_id, phase_id)`, plus index on `fallback_of_invocation_id` for escalation analytics.
- **Acceptance:** CRUD + queries by `runId`, `phaseId`, and `runtime`. Round-trip preserves all fields.

## M4-02 — AgentRuntimeRouter + OpenCodeAgentAdapter

- **Labels:** `milestone:M4`, `area:infra`
- **Depends on:** M4-01, M3-03, M3-03c, M3-06
- **User story:** As the orchestrator, I want an `AgentPort` that routes invocations to the correct runtime adapter based on the requested profile, and a concrete OpenCode adapter so frontier-model phases work end-to-end.
- **Context:** ADR-0007, PRD §15.7, Q13, Q24.
- **Scope:**
  - `AgentRuntimeRouter implements AgentPort` in `packages/infrastructure`:
    - Resolves `request.profile` via the loaded config.
    - Dispatches to the runtime adapter registered for that profile's `runtime`.
    - On adapter-returned failure that matches a configured fallback trigger (see M4-02c), invokes the phase's `fallbackProfile` (from the resolved `phaseProfiles` entry) and records the new `AgentInvocation` with `fallbackOfInvocationId` set.
  - `OpenCodeAgentAdapter implements AgentPort` (registered for `runtime: opencode`):
    - Spawn via `execa` with `cwd = worktreePath`, timeout from the resolved profile's `timeoutMinutes`.
    - Capture stdout / stderr to artifact files, fsync on close.
    - Record `startCommitSha`, `endCommitSha`, exit code, duration, runtime/provider/model.
    - Honour cancellation (Q23): on SIGTERM, kill child, await cleanup callback.
- **Acceptance:**
  - Successful invocation routed through the router produces `prompt.md`, `stdout.log`, `stderr.log`, `exit-code.txt`, and an `agent_invocations` row with `runtime: opencode` and the resolved profile name.
  - Timeout produces a `timeout` outcome with partial output preserved.
  - The router can be configured with only the OpenCode adapter and still pass all its tests (Pi is optional).
- **Test plan:** Integration test against a fake `opencode` shim script.

## M4-02b — PiAgentAdapter for local Qwen profiles

- **Labels:** `milestone:M4`, `area:infra`
- **Depends on:** M4-02
- **User story:** As the orchestrator, I want a Pi adapter so bounded local Qwen profiles execute through the same `AgentPort` contract as OpenCode.
- **Context:** ADR-0007, PRD §15.7. Target runtime: local Qwen 3.6 27B with 64k context limit. Specific model name is configurable.
- **Scope:**
  - `PiAgentAdapter implements AgentPort` in `packages/infrastructure`, registered with the router for `runtime: pi`.
  - Spawn `pi` (or the configured local harness binary) via `execa` with `cwd = worktreePath`.
  - Honour `contextLimitTokens`, `promptBudgetTokens`, `outputBudgetTokens`, and `timeoutMinutes` from the resolved profile. If the rendered prompt exceeds `promptBudgetTokens`, return a `contract_violation` outcome with reason `prompt_budget_exceeded` (do not silently truncate).
  - Capture stdout / stderr / exit code / duration identically to the OpenCode adapter.
  - Record `runtime: pi` and the configured provider/model on the `AgentInvocation` row.
- **Acceptance:**
  - Invocation through a Pi profile produces an `agent_invocations` row with `runtime: pi`.
  - Prompt-budget overflow produces a `contract_violation` invocation; the router escalates to the phase's `fallbackProfile` from `phaseProfiles` (covered by M4-02c).
  - Timeout produces a `timeout` outcome with partial output preserved.
- **Test plan:** Integration test against a fake `pi` shim script.

## M4-02c — Agent profile routing and fallback config

- **Labels:** `milestone:M4`, `area:application`, `area:infra`
- **Depends on:** M4-02, M4-02b
- **User story:** As an operator, I want the router to apply documented fallback triggers automatically so a Pi failure escalates to OpenCode without manual intervention.
- **Context:** PRD §15.7 "Promotion / fallback triggers". ADR-0007.
- **Scope:**
  - The router consults the resolved `phaseProfiles[phase].fallbackProfile` and escalates on any of the documented triggers:
    - two consecutive failures from the same profile on the same Step;
    - missing required artifact;
    - invalid `result.json`;
    - timeout;
    - context budget exceeded;
    - touched files exceed the expected limit declared by the phase;
    - validation failure changes category between iterations (signalled by the caller);
    - architectural ambiguity / reviewer-facing output requested (signalled by the caller).
  - Each escalation:
    - emits a `phase.fallback.escalated` event with `{ fromProfile, toProfile, triggerReason }`;
    - persists a new `AgentInvocation` row with `fallbackOfInvocationId` pointing at the failing invocation.
  - If the fallback profile itself fails, the failure surfaces as a normal `Failure` row — no further auto-escalation.
- **Acceptance:**
  - Each documented trigger has a passing test that asserts escalation happened and the escalated invocation links back to the failing one.
  - A `phaseProfiles` entry without a `fallbackProfile` surfaces the original failure without escalation.

## M4-03 — Prompt templating + context injection

- **Labels:** `milestone:M4`, `area:application`
- **Depends on:** M4-02
- **User story:** As an orchestrator, I want a hybrid template-plus-code prompt builder so I can compose prompts deterministically.
- **Context:** Q10, Q30. Templates in `prompts/<phase>/<step>.md`, code injects artifacts (e.g. `{{plan.md}}`).
- **Scope:**
  - `renderPrompt(template, context)` with `{{artifact:path}}` and `{{var:name}}` placeholders.
  - Prompt files live in `prompts/` and are versioned by git.
  - Rendered prompt stored as the invocation's `promptPath` artifact.
- **Acceptance:** Snapshot tests for each existing phase prompt.

## M4-04 — Agent contract validation

- **Labels:** `milestone:M4`, `area:application`
- **Depends on:** M4-02, M3-01
- **User story:** As the orchestrator, I want each invocation validated against its `AgentContract` so silent agent failures become loud.
- **Context:** PRD §15.6, Q9 (fail-fast), Q20 (branch safety).
- **Scope:**
  - Implements checks for: `requiredArtifacts`, `allowedResultValues`, `mustNotChangeBranch` (compare HEAD to `startCommitSha`/expected branch), `mustCreateCommit`, `mustPush`, `mustPostReplies`.
  - Violations recorded as `Failure` rows with `kind: agent_contract_violation` and detailed `contractViolations[]` on the invocation.
- **Acceptance:** Each invariant has a passing and failing unit test using fakes.

## M4-05 — Agent result extractor + `result.json` schema

- **Labels:** `milestone:M4`, `area:application`
- **Depends on:** M4-04
- **User story:** As the orchestrator, I want a typed `InvocationResult` so policy decisions don't depend on log scraping.
- **Context:** Q6, Q37. Each phase declares its allowed `result.json` shape.
- **Scope:**
  - Per-phase result Zod schemas: `plan-design`, `plan-write`, `implement`, `review`, `fix-review`, `create-pr`, `pr-review-poll`.
  - `extractResult(invocation)` parses `result.json` if present; falls back to a "extractor agent" invocation as documented in Q6.
  - Invalid result → `invalid_result` failure.
- **Acceptance:** Each schema accepts the existing Bash-produced `result.json` files captured from past runs.

## M4-06 — Replace agent calls in Bash review/plan/PR phases (incremental)

- **Labels:** `milestone:M4`, `area:bash`, `area:infra`
- **Depends on:** M4-02, M4-02c, M4-03, M4-04
- **User story:** As an automation owner, I want the Bash scripts to delegate single-shot agent calls to the runtime-agnostic Node runner so observability and routing are uniform regardless of which runtime executes the call.
- **Scope:**
  - Add a `node ./scripts/run-agent --profile <name>` CLI in `apps/cli` that the Bash scripts call instead of `opencode` directly. The CLI invokes `AgentPort.invoke(...)` — it does not name a runtime.
  - Migrate `plan-design`, `plan-write`, `review`, `fix-review`, and `create-pr` invocations first (the easiest single-shot calls). Each Bash call passes its current phase name verbatim; the CLI calls `resolveProfileForPhase` as a direct lookup against `phaseProfiles`. Unknown phase names raise a `ConfigError` — no silent fallback to `defaultProfile`. The eventual `review`+`fix-review` → `review-fix` collapse is M8's concern (see M8-06).
  - `implement` loop stays on direct `opencode` for now (covered by M8).
- **Acceptance:** All previously-Bash-driven agent calls write `agent_invocations` rows with the resolved profile, runtime, provider, and model. End-to-end run still succeeds for both `opencode` and `pi` profiles (where the latter is configured).

---

# Milestone M5 — TypeScript Validation Runner

**Goal:** Replace brittle log parsing of validation output with structured per-command results. Validation-fix invocations route through `AgentPort` using `phaseProfiles["validate-fix"]`; bounded fixes may run on Pi/Qwen with fallback to OpenCode per ADR-0007.

## M5-01 — Validation domain + DB table

- **Labels:** `milestone:M5`, `area:domain`, `area:persistence`
- **Depends on:** M3-01, M1-04
- **Scope:**
  - `ValidationRun { id, runId, phaseId, commands: ValidationCommandResult[] }`.
  - `ValidationCommandResult { command, exitCode, durationMs, stdoutPath, stderrPath, outcome, classifier? }`.
  - `validation_results` SQLite table.

## M5-02 — `ValidationAdapter` runs configured commands

- **Labels:** `milestone:M5`, `area:infra`
- **Depends on:** M5-01, M1-02
- **User story:** As the orchestrator, I want each `validation.commands` entry executed independently so I can see which one failed.
- **Scope:**
  - Read commands from `.ai-orchestrator.json`.
  - Run each via `execa`, capture stdout/stderr to per-command files (`validate/<n>-<slug>.{stdout,stderr}.log`).
  - Apply `validation.timeout` per command.
  - Write `validation-result.json` summarising the run.
- **Acceptance:** A failing typecheck does not short-circuit a passing build — both produce records.

## M5-03 — Failure classifier for validation

- **Labels:** `milestone:M5`, `area:application`
- **Depends on:** M5-02
- **Scope:** Classify exit code + stderr tail into typed `validation_failed` failures (`build`, `lint`, `typecheck`, `test` subtypes when known from command name).
- **Acceptance:** Snapshot tests over real `pnpm` output samples.

## M5-04 — Validation UI

- **Labels:** `milestone:M5`, `area:ui`
- **Depends on:** M5-02, M1-07
- **Scope:**
  - New "Validation" tab on run detail.
  - Per-command card with command, status, duration, expandable stdout/stderr.
  - Failing commands surfaced at top.
- **Acceptance:** Tab renders for runs with and without validation data.

## M5-05 — Bash script calls Node validator

- **Labels:** `milestone:M5`, `area:bash`
- **Depends on:** M5-02
- **Scope:** Replace the Bash `validate` phase commands with a call to `node ./scripts/run-validation` that returns `validation-result.json`. Bash uses its exit code only for pass/fail.
- **Acceptance:** Existing review/fix loop still triggers correctly off validation failure.

---

# Milestone M6 — Managed PR Review Polling

**Goal:** Replace unmanaged `nohup` PR polling with a first-class durable job model. PR-review comment handling defaults to OpenCode/frontier and is invoked via `AgentPort` using `phaseProfiles["pr-review-poll"]` — reviewer-facing output is not routed to Pi/Qwen.

## M6-01 — PR review domain + tables

- **Labels:** `milestone:M6`, `area:domain`, `area:persistence`
- **Depends on:** M3-01, M1-04
- **Scope:**
  - Domain types `PrReviewComment`, `PrReviewReply`, `PollAttempt`.
  - Tables: `pr_review_comments`, `pr_review_replies`, `processed_comment_ids`, `jobs`, `job_attempts`.
  - Reuse the same `Run` (Q17): PR review polling is the `pr-review-poll` phase, not a separate Run.

## M6-02 — GitHubPort implementation (gh CLI adapter)

- **Labels:** `milestone:M6`, `area:infra`
- **Depends on:** M3-03
- **Scope:**
  - `GhCliAdapter implements GitHubPort` covering `getIssue`, `getPr`, `listReviewComments`, `replyToReviewComment`, `updateIssueLabels`, `getPrState`, `createPullRequest`.
  - All calls via `gh api`/`gh pr` with structured JSON.
  - Retry with backoff for transient 5xx; surface `github_failed` failure otherwise.
- **Acceptance:** Stubbed `gh` shim drives the unit tests; real `gh` covered by an opt-in integration suite.

## M6-03 — `ProcessPrReviewComments` use case

- **Labels:** `milestone:M6`, `area:application`
- **Depends on:** M6-01, M6-02, M4-02
- **Scope:**
  - Fetch comments → filter processed → for each unprocessed: invoke `receiving-code-review` agent via AgentPort with a contract requiring `result.json` (`ALL_DONE | NO_FIXES_NEEDED | PARTIAL | BLOCKED`).
  - On code change: commit + push via GitPort. Verify commit pushed.
  - Post reply via GitHubPort. Verify reply visible.
  - Record per-comment processed status with the reply id and verification outcome.
  - Honour `phases.reviewFix.maxIterations` and global `timeouts.readyMaxDays`.
- **Acceptance:** End-to-end test in isolation using fakes.

## M6-04 — Managed poller (in-process scheduler)

- **Labels:** `milestone:M6`, `area:application`
- **Depends on:** M6-03
- **Scope:**
  - Replace `nohup` background process with a durable job in the `jobs` table.
  - Single worker drains the queue at the configured interval (defaults to PRD §23.2 `pollIntervalSeconds`).
  - Poller emits `pr-review-poll.poll.*` events.
  - On `gh` rate-limit, back off and re-enqueue.

## M6-05 — Bash script delegates polling

- **Labels:** `milestone:M6`, `area:bash`
- **Depends on:** M6-04
- **Scope:** `scripts/ai-pr-review-poll` becomes a thin shim that enqueues the managed job, or `ai-run-issue-v2` enqueues directly on PR create. Old polling loop removed.

## M6-06 — UI: PR Review tab

- **Labels:** `milestone:M6`, `area:ui`
- **Depends on:** M6-03, M1-07
- **Scope:** Per-comment cards (file, line, reviewer, body, processed status, agent assessment, fix summary, reply body, reply posted, verification). Poll status panel (poll count, max, next poll, latest status).

## M6-07 — Reactivation: READY → RUNNING on new review activity

- **Labels:** `milestone:M6`, `area:application`
- **Depends on:** M6-04, M3-01
- **Context:** Q17, Q33. READY is a resting state; new review activity reactivates.
- **Scope:**
  - Poller checks PR for new review activity even after READY.
  - Reactivation event recorded; Run transitions back to RUNNING.
  - Global timeout (`timeouts.readyMaxDays`) → CANCELLED.

---

# Milestone M7 — TypeScript Review/Fix Loop

**Goal:** Make the internal review/fix Loop a first-class, observable, resumable, bounded cycle that supports per-iteration runtime routing via `AgentPort`. Bounded fix iterations may use Pi/Qwen; the loop escalates to OpenCode on repeated failure or any documented fallback trigger.

## M7-01 — Loop domain + iteration tracking

- **Labels:** `milestone:M7`, `area:domain`, `area:persistence`
- **Depends on:** M3-01, M1-04
- **Scope:**
  - Domain `Loop { id, runId, phaseId, type: 'review-fix' | 'implement-step', iterations: LoopIteration[], maxIterations, status }`.
  - Per-iteration record `LoopIteration { index, reviewInvocationId, fixInvocationId?, revalidationId?, outcome }`.
  - Loop exhaustion → enclosing Phase FAILED (per Q8).
- **Acceptance:** Unit tests for max-iteration enforcement.

## M7-02 — `ReviewFixLoop` use case

- **Labels:** `milestone:M7`, `area:application`
- **Depends on:** M7-01, M4-02, M4-05, M5-02
- **Scope:**
  - Pipeline: review → if findings → fix → revalidate → re-review. Loop until `result.json.outcome === 'all_resolved'` or max iterations.
  - Each iteration writes artifacts under `phases/review_fix/loop-<n>/`.
  - Emits events: `loop.iteration.started`, `loop.iteration.completed`, `loop.exhausted`.
- **Acceptance:**
  - Loop converges within max for a fixture that resolves on iteration 2.
  - Loop marks phase FAILED when max reached.

## M7-03 — Bash phases delegate to Node loop

- **Labels:** `milestone:M7`, `area:bash`
- **Depends on:** M7-02
- **Scope:** The Bash `review` + `fix-review` phases become a single call to `node ./scripts/run-review-fix`. Bash retains its outer control flow.

## M7-04 — UI: Review/Fix loop visualisation

- **Labels:** `milestone:M7`, `area:ui`
- **Depends on:** M7-02, M1-07
- **Scope:** Per-iteration view (review markdown, fix log, revalidation status). Final review status badge.

---

# Milestone M8 — Full TypeScript Phase Orchestration

**Goal:** Retire Bash control flow. TypeScript drives every phase. All phase handlers call `AgentPort.invoke(...)` and remain runtime-agnostic — they never name `opencode` or `pi` directly. Bash, if anything remains, is only an infrastructure adapter for a specific tool.

## M8-01 — Phase definition registry

- **Labels:** `milestone:M8`, `area:application`
- **Depends on:** M3-01
- **Context:** Q25, Q31, Q32.
- **Scope:**
  - Declarative phase definitions with `name`, `inputs: { required, optional }`, `outputs`, `agentContract`, `retrySafety`, `skippable`.
  - Canonical order: `read_issue → plan-design → plan-write → implement → validate → review-fix → compound → create-pr → pr-review-poll → done`.
  - Skip list from `.ai-orchestrator.json`.
  - Pre-flight: refuse to start a phase whose required inputs are missing.
- **Acceptance:** Unit tests assert canonical order and input gating.

## M8-02 — `read_issue` phase handler

- **Labels:** `milestone:M8`, `area:application`, `area:infra`
- **Depends on:** M6-02, M8-01
- **Scope:** Fetch issue + comments via GitHubPort, validate required body sections, write `issue.md`/`issue-comments.md`.

## M8-03 — `plan-design` and `plan-write` phase handlers

- **Labels:** `milestone:M8`, `area:application`
- **Depends on:** M4-06, M8-01
- **Scope:** Single-shot agent invocations with contracts requiring `design.md` and `plan.md` respectively.

## M8-04 — `implement` phase handler with step loop

- **Labels:** `milestone:M8`, `area:application`
- **Depends on:** M7-02, M8-03
- **Context:** Q3 implementation tasks → Steps with internal Loops (spec-review + quality-review + fix, max 5).
- **Scope:**
  - Read `plan.md`, derive ordered Steps.
  - For each Step: invoke implement agent → spec-review → quality-review → fix loop.
  - Step success persists immediately; resume picks up from first FAILED step (Q4).

## M8-05 — `validate` phase handler

- **Labels:** `milestone:M8`, `area:application`
- **Depends on:** M5-02, M8-01
- **Scope:** Thin wrapper around the M5 validation runner; sets phase outcome from `validation-result.json`.

## M8-06 — `review-fix` phase handler (collapses legacy `review` + `fix-review`)

- **Labels:** `milestone:M8`, `area:application`, `area:bash`, `area:ui`
- **Depends on:** M7-02, M8-05
- **Scope:**
  - Use M7's `ReviewFixLoop` directly; honour `phases.reviewFix.maxIterations`.
  - **Coordinated rename:** This story is where the two shipped Bash phases (`review`, `fix-review`) collapse into the single domain canonical `review-fix` (per Q2). The rename must land atomically across:
    - `apps/web/src/lib/timeline.ts` phase array and `apps/web/src/app/runs/[id]/phase-timeline.tsx` label map
    - `apps/web/e2e/run-detail-timeline.spec.ts` and other tests
    - `packages/infrastructure/src/failure/classifier.ts` and its tests
    - `scripts/ai-run-issue-v2` phase list (until the script is retired in M8-11)
    - `.ai-orchestrator.json` `agent.phaseProfiles`: two keys `review` + `fix-review` become a single `review-fix` entry
- **Acceptance:** No code path emits or consumes the legacy `review` or `fix-review` phase names after this story merges; `phaseProfiles` carries a single `review-fix` entry; all timeline / classifier / e2e tests pass with the unified phase.

## M8-07 — `compound` phase handler

- **Labels:** `milestone:M8`, `area:application`
- **Depends on:** M8-06
- **Scope:** Skippable (default skipped per Q26 sample). When enabled, agent writes `compound.md` documenting learnings.

## M8-08 — `create-pr` phase handler

- **Labels:** `milestone:M8`, `area:application`, `area:infra`
- **Depends on:** M6-02, M8-06
- **Context:** Q16. Agent drafts PR description; orchestrator calls GitHub API.
- **Scope:**
  - Agent invocation with contract requiring `pr-summary.md`.
  - Orchestrator calls `createPullRequest` via GitHubPort, writes `pr-url.txt`, updates issue labels.

## M8-09 — `pr-review-poll` phase handler

- **Labels:** `milestone:M8`, `area:application`
- **Depends on:** M6-04, M8-08
- **Scope:** Enqueue managed poll job; Run transitions to READY when poller reports `all_resolved`; reactivates on new activity (M6-07).

## M8-10 — TypeScript run executor (state machine)

- **Labels:** `milestone:M8`, `area:application`
- **Depends on:** M8-01..M8-09
- **Scope:**
  - `RunExecutor` consumes phase registry; advances phases; persists state after every transition.
  - Resume picks up at the failed Step (Q4) by default; `--retry-phase` flag re-runs from start of phase.
  - Cancellation kills child agent process and resets worktree to `startCommitSha` (Q23/Q24).
- **Acceptance:** Full happy-path issue run completes end-to-end without invoking any Bash control logic.

## M8-11 — Retire / quarantine legacy Bash scripts

- **Labels:** `milestone:M8`, `area:bash`, `area:docs`
- **Depends on:** M8-10
- **Scope:**
  - Move `scripts/ai-run-issue-v2` → `scripts/legacy/` with a deprecation banner.
  - Keep `scripts/lib/emit_event.sh` only if still used by an adapter.
  - Update README, ADR-0002 documenting the cutover.
- **Acceptance:** Default user workflow does not invoke legacy scripts.

## M8-12 — Retry / Resume / Cancel API + UI controls

- **Labels:** `milestone:M8`, `area:api`, `area:ui`
- **Depends on:** M8-10
- **Scope:**
  - `POST /api/runs/:runId/cancel`, `/retry`, `/resume {fromPhase}`.
  - UI buttons on run detail with guard: "retry phase from scratch" requires confirmation when the phase is marked unsafe to retry (e.g. `create-pr` after PR creation).
- **Acceptance:** End-to-end test: fail a run at `review-fix`, click Resume, watch the run complete.

## M8-13 — Worktree lifecycle adapter

- **Labels:** `milestone:M8`, `area:infra`
- **Depends on:** M3-03, M8-10
- **Context:** Q14, Q23.
- **Scope:**
  - `GitWorktreeAdapter implements GitPort` managing `.ai-worktrees/issue-<N>`.
  - Verify clean (reset to latest `main`) at Run start.
  - Reset to `startCommitSha` on cancel.
- **Acceptance:** Unit tests against a temp git repo.

## M8-14 — Domain invariant enforcement audit

- **Labels:** `milestone:M8`, `area:application`
- **Depends on:** M8-10
- **Scope:** Audit + tests verifying every invariant from PRD §12 is enforced in code (one active Run per issue, missing artifact → failure, invalid result → failure, branch change → failure, loop exhaustion → FAILED, no duplicate comment processing, etc.).
- **Acceptance:** Each invariant has at least one test that would fail if the invariant were removed.

---

## Dependency overview

```text
M1-01 ──┬─► M1-02
        ├─► M1-03 ─► M1-04 ─► M1-05 ─► M1-06
        │                       └─► M1-07
        │                       └─► M2-* … M8-*
        └─► M3-01 ─► M3-02 ─► M3-03 ─► M3-04 / M3-05 ─► M3-06
                                            │
                                            ├─► M3-03a/03b/03c (agent seam)
                                            ├─► M4-01 ─► M4-02 ─► M4-02b ─► M4-02c ─► M4-03/04/05 ─► M4-06
                                            ├─► M5-01 ─► M5-02 ─► M5-03/04/05
                                            ├─► M6-01 ─► M6-02 ─► M6-03 ─► M6-04 ─► M6-05/06/07
                                            └─► M7-01 ─► M7-02 ─► M7-03/04
                                                          │
                                                          └─► M8-01..M8-14
```

## Labels to create in GitHub

`milestone:M1` … `milestone:M8`; `area:domain`, `area:application`, `area:infra`, `area:persistence`, `area:ui`, `area:api`, `area:cli`, `area:bash`, `area:config`, `area:docs`.

## Suggested issue creation order

Top-to-bottom in this document. Within each milestone, story IDs are already in dependency order.
