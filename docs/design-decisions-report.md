# AI SDLC Orchestrator — Design Decisions Report

All questions resolved during the grill-with-docs session.

---

## Q1 — Run identity

**How is a Run identified and scoped?**
UUID-identified, scoped to exactly one approved Repository (`RepositoryId`) and one GitHub `issueNumber`. One active Run per (Repository, Issue) pair (domain invariant). Previous Run must be terminal (SUCCESS/FAILED/CANCELLED) before a new one starts.

## Q2 — Phase structure

**How does review/fix fit into the phase model?**
Review/fix is a single Phase (`review-fix`) with an internal Loop in the **target** domain model. Each Loop iteration = one review + one fix. Phase sequence advances monotonically. As of M8-06 (#381), the observability surface (`apps/web/src/lib/timeline.ts`, classifier, DB, scripts) uses the single canonical `review-fix` phase name. The `review` + `fix-review` → `review-fix` collapse was completed as a coordinated rename across config, code, tests, and docs. Loop-internal routing keys (`whole-pr-review`, `fix-review`, `whole-pr-fix-review`, `fix-review-architect`) remain in `phaseProfiles` for agent-profile dispatch within the review-fix loop.

## Q3 — Implement phase internals

**How are implementation tasks modeled?**
`implement` is one Phase, tasks are Steps within it. Each Step groups related Agent Invocations. Steps can have their own Loops (spec-review + quality-review + fix, max 5 iterations).

## Q4 — Resume granularity

**Where does a failed Run resume from?**
Resume from the failed Step by default (trust prior steps' commits). User can choose "retry phase from scratch" as escape hatch.

## Q5 — Step completion signal

**What determines whether a Step completed?**
Both DB + filesystem. DB records step status transitions with timestamps (source of truth for state). Filesystem holds artifacts (source of truth for content). On resume, check both — mismatch = corruption flag requiring user decision.

## Q6 — Agent Invocation result

**What shape does an Agent Invocation's result take?**
Typed `InvocationResult` with:

1. Outcome enum: SUCCESS | FAILED | PARTIAL (stored in DB)
2. Payload: optional structured JSON, schema varies by phase (stored as `result.json` artifact on filesystem)

Result resolution is **deterministic-first** (see M4-05): parse `result.json` against the phase's Zod schema; if missing/invalid and the phase is marked `retrySafe`, rerun the same invocation once with a contract-violation reminder prepended; otherwise fail with `invalid_result` or `agent_contract_violation`. No LLM extractor in the hot path. An offline extractor helper may exist for operator-driven diagnostics on archived runs, but it is not wired into the normal control flow.

## Q7 — PARTIAL outcome scope

**Where can PARTIAL appear?**
PARTIAL only valid at Phase level (some Steps done, some not). Steps are binary SUCCESS/FAILED. Aligns with resume-from-failed-Step semantics.

## Q8 — Loop exhaustion

**What happens when a Loop hits max iterations?**
Enclosing Step/Phase marked FAILED, Run stops, user must intervene (retry, adjust, or cancel).

## Q9 — Agent Contract validation

**When and how are agent contracts validated?**

- 9a: Validate immediately after each invocation (fail-fast)
- 9b: Contract violation treated as plain FAILED outcome; retry loop handles it

## Q10 — Prompt versioning

**How are prompts versioned?**
Prompts in separate files in a known directory, referenced by phase/step name. Git provides version history. Agent Invocation record stores prompt file path.

## Q11 — Concurrency

**Does the system support concurrent Runs?**
Yes, with repo-scoped boundaries. Multiple Repositories may run concurrently; multiple Workers (one process each) drain a shared SQLite-backed Job queue. The hard invariants are: one active Run per (Repository, Issue) and one active WorkerLease per Repository. A Worker must acquire the repo lease before preparing a worktree or executing any phase. See ADR-0008.

## Q12 — State persistence

**How is Run state persisted?**
Hybrid. Mutable status columns on Run/Phase/Step tables for fast reads. Separate append-only events table logs every transition for history/observability.

## Q13 — Agent execution

**How does the orchestrator invoke agents?**
Through a runtime-agnostic `AgentPort` with explicit, configured runtime adapters. Initial runtimes are `opencode` (frontier-model harness, for high-context/high-judgment work) and `pi` (local small-model harness, for bounded Qwen tasks — e.g. Qwen 3.6 27B with a 64k context limit). Each adapter treats its runtime as a black box (prompt in → artifacts out) and the orchestrator owns state, contracts, validation, retry/resume, fallback, and failure classification. See ADR-0007.

## Q14 — Git worktree lifecycle

**How are worktrees managed?**
Worktree scoped to issue (`.ai-worktrees/issue-<N>`), reused across Runs. On new Run start, orchestrator verifies worktree is clean (reset to latest main). One-active-Run-per-issue invariant prevents contention.

## Q15 — Artifact storage

**Where do artifacts live?**
Split. Orchestration metadata (prompts sent, result.json, logs) in `.ai-runs/`. Agent-consumable artifacts (design.md, plan.md) in `.ai/` within the worktree. `.ai/` gitignored.

## Q16 — PR creation

**Who creates the PR?**
Orchestrator invokes agent to draft PR description, then orchestrator calls GitHub API via GitHubPort. Separation of creative (agent) from mechanical (API call).

## Q17 — Post-PR review polling

**Is review polling a separate Run or part of the same one?**
Same Run extended. After create-pr, Run transitions into pr-review-poll phase. Run isn't completed until PR merged or user cancels. One continuous lifecycle issue-to-merged-PR.

## Q18 — Poll mechanism

**How does the system check for new reviews?**
Timer-based polling for MVP, designed so webhook-driven is addable later. The GitHubPort abstraction hides whether "check for reviews" is poll or webhook.

## Q19 — User intervention model

**How do users interact with the orchestrator?**
REST API exposes retry/cancel/resume. Both Web UI and CLI are thin clients over the same API. API-first, neither surface privileged.

## Q20 — Branch safety

**What happens if the agent switches branches?**
Verify-and-fail. Check HEAD is on expected branch after each Agent Invocation. If drifted, mark invocation FAILED, let retry loop handle it.

## Q21 — UI observability

**How does the UI show Run progress?**
MVP: stream structured events from append-only event log via SSE. Enhancement: live agent stdout. Raw agent output written to log file artifact, viewable after the fact.

## Q22 — Validation commands

**How does the orchestrator know what to validate?**
Explicit config file (`.ai-orchestrator.json`) at repo root declares validation commands. Deterministic — same commit always produces same pass/fail. Fail fast if config missing.

## Q23 — Cancellation semantics

**What happens to in-flight work on cancel?**
Kill with cleanup. SIGTERM the process, then reset the worktree to last known-good commit (the commit before this invocation started). Mark Run CANCELLED with clean state.

## Q24 — Last known-good commit tracking

**When is the baseline commit recorded?**
At Agent Invocation start. Before spawning opencode, capture `git rev-parse HEAD` in the worktree and store it on the AgentInvocation record as `startCommitSha`.

## Q25 — Phase sequence

**Is the phase order fixed or configurable?**
Fixed default with skip-list. The canonical sequence is hardcoded. Config can declare phases to skip. Can't reorder, can only omit.

## Q26 — `.ai-orchestrator.json` config shape

**What's the MVP config structure?**

The M1/M2 config covers validation, phase skip-list, and timeouts. Starting in M3 (per Q27), the file also gains an `agent` section for runtime/model routing — see PRD §15.7 for the full schema and routing policy. The complete MVP shape is:

```json
{
  "validation": {
    "commands": ["pnpm build", "pnpm lint", "pnpm typecheck", "pnpm test"],
    "timeout": 300
  },
  "phases": {
    "skip": ["compound"],
    "reviewFix": { "maxIterations": 10 },
    "implement": { "maxIterations": 5 }
  },
  "timeouts": {
    "readyMaxDays": 7,
    "invocationMaxMinutes": 30
  },
  "agent": {
    "defaultProfile": "opencode-frontier",
    "profiles": {
      "opencode-frontier": {
        "runtime": "opencode",
        "provider": "anthropic",
        "model": "claude-opus-4.7",
        "timeoutMinutes": 60
      },
      "pi-qwen-local": {
        "runtime": "pi",
        "provider": "local",
        "model": "qwen3.6-27b",
        "contextLimitTokens": 64000,
        "promptBudgetTokens": 40000,
        "outputBudgetTokens": 8000,
        "timeoutMinutes": 30
      }
    },
    "phaseProfiles": {
      "plan-design": { "profile": "opencode-frontier" },
      "plan-write": { "profile": "opencode-frontier" },
      "implement": { "profile": "pi-qwen-local", "fallbackProfile": "opencode-frontier" },
      "validate": { "profile": "pi-qwen-local", "fallbackProfile": "opencode-frontier" },
      "review": { "profile": "opencode-frontier" },
      "fix-review": { "profile": "opencode-frontier" },
      "compound": { "profile": "pi-qwen-local", "fallbackProfile": "opencode-frontier" },
      "create-pr": { "profile": "opencode-frontier" },
      "pr-review-poll": { "profile": "opencode-frontier" }
    }
  }
}
```

The `agent` section is the source of truth for runtime/model routing per Q27 and PRD §15.7. M1/M2 configs without an `agent` section are valid until M3 lands; M3 onward requires it.

## Q27 — Agent model/runtime selection

**Where does model config live?**
In `.ai-orchestrator.json` under `agent.profiles` and `agent.phaseProfiles` (see PRD §15.7). Profiles bind a runtime (`opencode | pi`), provider, model, budgets, and timeout. Phases reference profiles via `phaseProfiles` entries, which also carry an optional `fallbackProfile` — **fallback is a per-phase routing concern, not a property of a profile**. Selection is config-driven, phase-aware, auditable, and fallback-capable. Env vars (`AI_MODEL`, `AI_RUNTIME`) may still override the active profile per process for local experimentation, but the source of truth is the config file.

## Q28 — Error classification

**Are failures classified as transient vs. permanent?**
No. All failures are equal for MVP. Loop retries up to max iterations regardless. If truly permanent, loop exhausts and user intervenes.

## Q29 — Event schema

**What's in the append-only events table?**
Rich with payload: `{ id, runId, timestamp, type, entityId, fromState, toState, metadata: JSON }`. Metadata carries context (outcome, durationMs, commitSha, reason, loopIteration).

## Q30 — Prompt construction

**How does the orchestrator build prompts?**
Hybrid: template skeleton + programmatic context injection. Template provides structure/instructions, code handles which artifacts to include and how to format them.

## Q31 — Artifact dependency between phases

**How does the orchestrator know which artifacts a phase needs?**
Declared in phase definitions. Phase metadata declares inputs/outputs: `{ inputs: [...], outputs: [...] }`. Orchestrator verifies inputs exist before starting a phase.

## Q32 — Skipped phase artifact dependencies

**What if a skipped phase was supposed to produce a needed artifact?**
Inputs are "required" or "optional". Phase declares `{ inputs: { required: ["plan.md"], optional: ["compound.md"] } }`. Optional inputs passed if present, silently omitted if not.

## Q33 — Run completion

**How does the orchestrator know a Run is done?**
Three states beyond RUNNING: SUCCESS (PR merged, terminal), READY (all reviews addressed, awaiting merge — not terminal, reactivates on new review activity), CANCELLED (timeout or user-cancelled, terminal). Global timeout applies to READY state.

## Q34 — Global timeout configuration

**Where are timeouts configured?**
In `.ai-orchestrator.json` under `"timeouts": { "readyMaxDays": 7, "invocationMaxMinutes": 30 }`. Workflow concern, not operational.

## Q35 — Event stream subscription

**How does the UI subscribe to events?**
Subscribe by Run ID. Client opens `GET /runs/:id/events?since=<timestamp>`. Single endpoint, reconnects periodically. Gets all events including reactivation.

## Q36 — SQLite vs Postgres

**When does the system outgrow SQLite?**
Don't decide now. The RunRepository port means storage is swappable. Cross that bridge when performance or access patterns demand it.

## Q37 — Structured vs markdown review findings

**How does the agent report review results?**
Both, structured is authoritative. `result.json` has pass/fail decision the orchestrator acts on. `review.md` is the human-readable artifact the fix agent consumes as context.

## Q38 — Distributed workers

**Is distribution in scope?**
Multi-machine distribution is explicitly out of scope. A single VPS running multiple local Worker processes under systemd **is** in scope and is the target VPS deployment mode (ADR-0008). All Workers in that deployment share the same filesystem and the same SQLite file; horizontal scale across machines is not supported. Distributed databases, Redis-backed queues, and Kubernetes are non-goals.

## Q39 — Config shape confirmation

**Is the `.ai-orchestrator.json` shape complete for MVP?**
Confirmed. See Q26 for the full shape including the M3+ `agent` section (and PRD §15.7 for the routing-policy and fallback-trigger details).
