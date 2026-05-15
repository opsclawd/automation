# Worktree reuse and cancellation safety

We reuse one issue-scoped worktree per issue and make cancellation restore a clean state so long-running work can resume safely.

## Considered Options

**Worktree lifecycle**: Create a fresh worktree for every Run vs. reuse a persistent worktree per issue. We chose per-issue reuse to keep the local workflow fast and preserve context between Runs.

**Concurrency**: Allow multiple active Runs per issue vs. enforce exclusivity. We chose one active Run per issue to prevent worktree contention and duplicate commits.

**Start-state handling**: Trust the current branch state vs. verify and reset before starting. We chose to verify the worktree is clean and reset it to the latest main baseline before each Run.

**Cancel behavior**: Leave the workspace dirty vs. reset to the last known-good commit. We chose kill-with-reset so cancellation leaves the worktree ready for the next attempt.

## Consequences

- Repeated Runs on the same issue stay efficient
- Branch drift and stale state are caught early
- Cancellation is safe enough to use as a normal control, not a last resort
- The orchestrator can assume one clean execution context per issue
