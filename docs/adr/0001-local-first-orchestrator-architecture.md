# Local-first orchestrator with hybrid persistence and clean cancellation

We chose a local-first, single-machine architecture for the AI SDLC Orchestrator — SQLite + filesystem hybrid persistence, a runtime-agnostic `AgentPort` with explicit adapters (initially OpenCode and Pi), git worktrees reused per-issue, and clean cancellation via worktree reset to last known-good commit. Distributed workers are an explicit non-goal.

## Considered Options

**Persistence**: Full event sourcing vs. mutable tables vs. hybrid. We chose hybrid (mutable status columns for fast reads, append-only rich events for observability). Events are not the source of truth — they're an audit trail. This avoids projection complexity while preserving full timeline visibility.

**Agent execution**: Single hardcoded runtime vs. open-ended generic plug-in system vs. a closed set of explicit adapters behind one port. We chose the closed-set approach: `AgentPort` is runtime-agnostic, and we ship two explicit adapters — `OpenCodeAgentAdapter` for frontier-model work and `PiAgentAdapter` for local Qwen work. M1 used `opencode` only because we hadn't yet built the seam; M3 introduces the abstraction and M4 implements both adapters. We are not building a generic workflow engine and will not auto-select runtimes by opaque LLM judgment — routing is driven by declared `AgentProfile`s and explicit fallback rules. See ADR-0007.

**Cancellation**: Kill-and-leave-dirty vs. wait-for-completion vs. kill-with-reset. We chose kill-with-reset — SIGTERM the agent process, then `git reset --hard` to the `startCommitSha` recorded at invocation start. This keeps the worktree clean for the next Run, since worktrees are reused across Runs for the same issue.

**Distribution**: The port-based architecture (RunRepository, AgentPort, GitHubPort) technically allows swapping in remote implementations, but every concrete decision — filesystem artifacts, SQLite, worktree reuse, env-var model selection — is inherently local. Designing for distribution would require rethinking half the architecture for a scenario that doesn't exist.

## Consequences

- The system cannot run on multiple machines or serve multiple users without significant rearchitecture
- SQLite is the persistence engine indefinitely; Postgres migration is possible via RunRepository port but not planned
- All orchestration state lives on one filesystem — backup is `cp -r`, debugging is `sqlite3` + `ls`
- Agent runtimes are a closed, configured set (`opencode`, `pi`); adding a new runtime is a deliberate act of writing a new `AgentPort` adapter, not a runtime configuration toggle
