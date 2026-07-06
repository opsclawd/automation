# Single-tenant orchestrator with hybrid persistence and clean cancellation

We chose a single-tenant orchestrator architecture for the AI SDLC Orchestrator — SQLite + filesystem hybrid persistence, a runtime-agnostic `AgentPort` with explicit adapters (initially OpenCode and Pi), git worktrees scoped per (Repository, Issue, Run), and clean cancellation via worktree reset to last known-good commit. The orchestrator runs as a single process group, either locally on a developer machine or on a single VPS with multiple Worker processes under systemd. Multi-machine distributed workers are an explicit non-goal — see ADR-0008 for the VPS deployment, repo-scoped worker pool, and lease-based concurrency model.

## Considered Options

**Persistence**: Full event sourcing vs. mutable tables vs. hybrid. We chose hybrid (mutable status columns for fast reads, append-only rich events for observability). Events are not the source of truth — they're an audit trail. This avoids projection complexity while preserving full timeline visibility. SQLite (WAL mode) remains the persistence engine for the single-VPS scope; Postgres is a future-only consideration triggered by multi-VPS, heavy write contention, or HA — not adopted now.

**Agent execution**: Single hardcoded runtime vs. open-ended generic plug-in system vs. a closed set of explicit adapters behind one port. We chose the closed-set approach: `AgentPort` is runtime-agnostic, and we ship two explicit adapters — `OpenCodeAgentAdapter` for frontier-model work and `PiAgentAdapter` for local Qwen work. Originally, the system used `opencode` only because we hadn't yet built the seam; Both adapters are now implemented behind the AgentPort abstraction. We are not building a generic workflow engine and will not auto-select runtimes by opaque LLM judgment — routing is driven by declared `AgentProfile`s and explicit fallback rules. See ADR-0007.

**Cancellation**: Kill-and-leave-dirty vs. wait-for-completion vs. kill-with-reset. We chose kill-with-reset — SIGTERM the agent process, then `git reset --hard` to the `startCommitSha` recorded at invocation start, then release the repo `WorkerLease`. This keeps the worktree clean for the next Run on that Repository.

**Distribution**: Multi-machine distribution remains out of scope. Running multiple Worker processes on a single VPS (see ADR-0008) is supported because every process shares the same filesystem and SQLite file; spreading Workers across multiple machines would require rethinking persistence, leasing, and artifact storage for a scenario that does not exist.

## Consequences

- The orchestrator runs as a single process group on one machine (local or one VPS). Horizontal scale across machines is not supported.
- SQLite is the persistence engine for the foreseeable future; Postgres migration is possible via repository ports but not planned.
- All orchestration state lives on one filesystem — backup is `cp -r`, debugging is `sqlite3` + `ls`.
- Agent runtimes are a closed, configured set (`opencode`, `pi`); adding a new runtime is a deliberate act of writing a new `AgentPort` adapter, not a runtime configuration toggle.
- Repository registration, job queuing, worker pool, and lease semantics are deferred to ADR-0008 and are now implemented.
