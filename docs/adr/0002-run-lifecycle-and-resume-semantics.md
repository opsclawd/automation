# Run lifecycle and resume semantics

We use explicit Run lifecycle states and step-level resume behavior so operators can recover failed work without guessing where to restart.

## Considered Options

**Lifecycle states**: A small explicit state machine vs. ad hoc booleans vs. inferred status from artifacts. We chose explicit states: `RUNNING`, `READY`, `SUCCESS`, `FAILED`, and `CANCELLED`. `READY` is non-terminal and reactivates on new review activity.

**Partial progress**: Allow PARTIAL only at Phase level vs. allow it on Steps too. We chose Phase-level PARTIAL only. Steps are binary: SUCCESS or FAILED. This keeps resume semantics simple: resume from the failed Step by default.

**Resume point**: Resume the whole Run vs. resume from the failed Phase vs. resume from the failed Step. We chose failed-Step resume by default, with an explicit escape hatch to retry a Phase from scratch.

**Loop exhaustion**: Keep retrying indefinitely vs. fail the enclosing unit after a limit. We chose bounded Loops. When a Loop hits max iterations, the enclosing Step or Phase becomes FAILED and the Run stops for user intervention.

## Consequences

- Operators can tell where a Run stopped and what can safely resume
- Recovery behavior is predictable and consistent across phases
- Review/fix can continue across new feedback without spawning a new Run
- The state machine stays small enough to reason about in docs, UI, and tests
