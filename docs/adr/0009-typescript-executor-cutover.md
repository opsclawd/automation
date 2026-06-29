# ADR-0009: TypeScript RunExecutor as Default Executor (M8-11 Cutover)

**Status:** Accepted  
**Date:** 2026-06-28  
**Supersedes:** N/A — extends ADR-0007 (agent runtime adapter architecture)

## Context

The orchestrator was originally implemented as a Bash script (`scripts/ai-run-issue-v2`) wrapping a Node.js agent runner (`apps/cli/src/run-agent.ts`). Over the M1–M8 milestone arc, the TypeScript `RunExecutor` was built incrementally to replace this:

- M4: runtime-agnostic `AgentPort` + adapters
- M6–M7: domain + application layer (phases, handlers, use cases)
- M8: `RunExecutor`, `GitWorktreeAdapter`, `WorkerLeaseRepository`, composition root, full handler set (read-issue through create-pr)

By M8-10, all phases were implemented in TypeScript with the composition root fully wired. Multiple end-to-end runs confirmed the TS executor produces real PRs through the full pipeline (`read_issue → plan-design → plan-write → implement → validate → review-fix → compound → create-pr`) without invoking the legacy Bash script.

## Decision

Flip the default executor from `bash` to `ts`. Quarantine `scripts/ai-run-issue-v2` and `scripts/ai-pr-review-poll` under `scripts/legacy/` with deprecation banners. Preserve (not delete) for emergency use.

The `--executor bash` flag continues to work but is no longer the default.

## Consequences

**Default workflow** is now `pnpm --filter @ai-sdlc/api dev run --issue N` → TypeScript `RunExecutor` → real composition root with `GhCliAdapter`, `GitWorktreeAdapter`, `WorkerLeaseRepository`, SQLite-backed runs.

**Legacy scripts** are at `scripts/legacy/ai-run-issue-v2` and `scripts/legacy/ai-pr-review-poll`. The `--executor bash` flag resolves to the legacy path. These scripts are not maintained going forward.

**Parity suite** (`scripts/lib/__tests__/legacy-parity.bats`, 77 tests) pins the invariants the Bash scripts established. The suite continues to run in CI. Per #210, retiring any parity row requires the TS path to cover the invariant — confirmed across all rows before this cutover.

**Retirement gate (M8-11):** The functional gate was satisfied by multiple end-to-end TS executor runs on this repo. The parity ratchet was confirmed green (all rows TS-driven or explicitly waived). See issue #365 and #210 for details.

## Emergency procedure

To use the legacy executor:

```bash
pnpm --filter @ai-sdlc/api dev run --issue N --executor bash
```

The script at `scripts/legacy/ai-run-issue-v2` emits a deprecation warning to stderr on startup.
