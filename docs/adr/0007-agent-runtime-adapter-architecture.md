# Runtime-agnostic AgentPort with explicit OpenCode and Pi adapters

## Decision

The orchestrator exposes agent execution to the application and domain layers through a single runtime-agnostic `AgentPort`. Two concrete adapters ship in M4: `OpenCodeAgentAdapter` (frontier-model runtime) and `PiAgentAdapter` (local Qwen runtime). Phases reference named `AgentProfile`s declared in `.ai-orchestrator.json`; an `AgentRuntimeRouter` resolves profile → runtime adapter at invocation time and handles configured fallback.

The seam is introduced in M3 (interfaces, fakes, composition root) without executing either runtime. M4 implements both adapters and the router.

## Context

- The first milestones (M1, M2) wrapped existing Bash automation that called `opencode` directly. Prior documentation positioned `opencode` as the initial and only runtime.
- A second runtime is becoming load-bearing: a local Qwen 3.6 27B harness (Pi) with a 64k context limit. It is well-suited to bounded mechanical work (small implement Steps, narrow validation fixes, compound documentation) but cannot replace a frontier model for design, planning, high-context review, or PR-comment handling.
- Without an abstraction, every phase handler would have to know which runtime it is calling, and runtime selection would leak into application/domain code.
- Introducing the seam before M3 ships keeps the abstraction cheap. Adding it later would require rewriting all phase handlers built against a runtime-specific API.

## Considered Options

**Keep `opencode` hardcoded.** Cheapest in the short term, but blocks local execution and makes cost control impossible. Rejected: we already need Pi/Qwen.

**Generic plug-in runtime registry (anyone can drop in an adapter).** Maximum flexibility, maximum design surface, no near-term need. Rejected: the system is not a generic workflow engine.

**Closed set of explicit adapters behind one port (chosen).** Two adapters today (`opencode`, `pi`). Adding a new runtime is a deliberate act of writing a new adapter, not a configuration toggle. Routing is declared in config via named profiles and explicit fallback rules — never inferred by opaque LLM judgment.

## Consequences

**Positive**

- The application layer stays runtime-agnostic; all phase handlers call `AgentPort.invoke(...)`.
- Cost control is real: bounded mechanical work runs locally on Pi/Qwen; frontier-only work runs on OpenCode.
- Local execution is possible for everything that fits Pi's context and judgment envelope.
- Every `AgentInvocation` records the selected profile, runtime, provider, model, prompt path, stdout/stderr paths, timeout, artifacts, `result.json`, and contract violations — auditable identically regardless of runtime.
- Fallback from Pi to OpenCode is observable: the escalated invocation links back to the failed one and emits a `phase.fallback.escalated` event.
- We avoid OpenCode lock-in without committing to abstracting every possible runtime.

**Negative / costs**

- More upfront abstraction in M3/M4 (port, profile types, router, fakes) before any user-visible benefit.
- Artifact contracts and the `result.json` schema become strict — agents that don't produce them are treated as FAILED.
- Fallback policy and escalation triggers must be specified up front and kept current as new failure modes emerge.

## Non-goals

- Supporting every possible agent runtime. The closed set is `opencode` and `pi` until a concrete need adds a third.
- Runtime auto-selection by opaque LLM judgment. Routing is config-driven (`phaseProfiles`) with explicit, documented escalation triggers.
- Turning the orchestrator into a generic workflow engine. The orchestrator owns state, policy, contracts, validation, retry/resume, and failure classification; runtime adapters only execute agent processes.

## Related

- PRD §13, §14, §15.3, §15.7, §29 (Milestones 3 and 4)
- ADR-0001 — Local-first orchestrator architecture
- ADR-0004 — Agent runtime and invocation contract
- `CONTEXT.md` — Agent Invocation, Agent Runtime, Agent Profile vocabulary
