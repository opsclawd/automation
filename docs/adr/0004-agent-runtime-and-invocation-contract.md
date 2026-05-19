# Agent runtime and invocation contract

We expose agent execution to the application layer as a single runtime-agnostic `AgentPort`, with concrete adapters per supported runtime, and require each invocation to produce a bounded, validated result.

## Considered Options

**Runtime support**: One hardcoded runtime vs. an open plug-in system vs. a closed set of explicit adapters. We chose the closed-set approach. The initial adapters are `OpenCodeAgentAdapter` (frontier-model runtime — high-context, high-judgment, planning, review, PR comments) and `PiAgentAdapter` (local small-model runtime, e.g. Qwen 3.6 27B with a 64k context limit, for bounded mechanical work). Adding a runtime is a deliberate act of writing an adapter, not a config toggle.

**Invocation boundary**: Let phases talk directly to tools vs. wrap agent calls in a dedicated contract. We chose a clear `Agent Invocation` contract with prompt path, stdout/stderr capture, result validation, structured exit metadata, and recorded profile/runtime/provider/model. Phase handlers call `AgentPort.invoke(...)` — they never name a concrete runtime.

**Result shape**: Free-form output vs. typed result + artifact files. We chose typed `AgentInvocationResult` plus filesystem artifacts. Prompt, stdout, stderr, and `result.json` remain inspectable and auditable regardless of which runtime executed the call.

**Start commit tracking**: Record the baseline only if cancellation is needed vs. record it at invocation start. We chose to capture `startCommitSha` before each invocation so cancellation can safely restore the worktree.

**Routing**: Hardcoded per phase vs. config-driven `AgentProfile` + `phaseProfiles` map. We chose config-driven routing with explicit `fallbackProfile` escalation (see PRD §15.7 and ADR-0007). Routing is auditable: each `AgentInvocation` records the selected profile and runtime, and fallback escalations link back to the failed invocation.

## Consequences

- Runtime changes are deliberate and explicit; phase handlers stay runtime-agnostic
- All agent execution is auditable through the same `AgentInvocation` record shape regardless of runtime
- Invalid or missing artifacts fail fast instead of drifting silently
- Cancellation can restore a known-good worktree state
- Agent behavior stays easy to audit from files on disk
- Fallback from local (Pi/Qwen) to frontier (OpenCode) is observable and configurable per phase
