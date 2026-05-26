---
title: Runtime-agnostic agent runner CLI (run-agent) — Bash-to-Node migration pattern
date: 2026-05-26
category: orchestrator
module: apps/cli
problem_type: migration
component: cli
symptoms:
  - Bash scripts shell out to opencode directly, bypassing AgentRuntimeRouter
  - No agent_invocations rows written for Bash-invoked phases
  - No adapter-level fallback or contract validation for Bash phases
  - Telemetry inconsistent across agent call paths
root_cause: missing_routing_layer
resolution_type: feature
severity: high
related_components:
  - apps/cli/src/run-agent.ts
  - packages/infrastructure/src/agent/agent-runtime-router.ts
  - scripts/ai-run-issue-v2
  - scripts/ai-pr-review-poll
  - apps/api/src/compose.ts
  - apps/api/package.json
tags:
  - cli
  - bash-migration
  - agent-routing
  - source-mode
  - pnpm-workspace
  - M4-06
---

# Runtime-Agnostic Agent Runner CLI (`run-agent`)

## Problem

Bash scripts (`scripts/ai-run-issue-v2`, `scripts/ai-pr-review-poll`) shelled out to `opencode` directly via inline argv, piping prompts through stdin. This bypassed `AgentRuntimeRouter` entirely — no `agent_invocations` rows were written, no adapter-level fallback fired, no contract validation executed, and telemetry was inconsistent across agent calls.

## Architecture

```
Bash script
  └─> pnpm --filter @ai-sdlc/cli exec tsx apps/cli/src/run-agent.ts \
        --phase plan-design --cwd ... --run-id ... --prompt-file ...
        └─> composeRoot() (from @ai-sdlc/api)
              └─> AgentRuntimeRouter.invoke()
                    ├─ Insert agent_invocations row
                    ├─ Resolve adapter (opencode/pi) from profile
                    ├─ Execute adapter
                    ├─ Handle fallback if needed
                    └─ Update invocation row with result
```

## CLI Flags

| Flag                   | Required       | Purpose                                           |
| ---------------------- | -------------- | ------------------------------------------------- |
| `--phase`              | Yes (for Bash) | Phase name resolved via `resolveProfileForPhase`  |
| `--profile`            | No             | Operator override. Unknown profile → exit 2.      |
| `--cwd`                | Yes            | Worktree directory for the agent                  |
| `--run-id`             | Yes            | Run UUID for invocation row plumbing              |
| `--repo-id`            | Yes            | Repository ID (e.g., `owner/repo`)                |
| `--phase-id`           | Yes            | Phase name stored in invocation row               |
| `--step-id`            | No             | Optional step identifier                          |
| `--prompt-file`        | Yes            | Path to pre-rendered prompt file                  |
| `--expected-artifacts` | No             | Comma-separated paths for contract validation     |
| `--timeout-minutes`    | No             | Override the profile's configured timeout         |
| `--start-sha`          | Yes            | Current HEAD sha                                  |
| `--repo-root`          | No             | Override repo root (avoids walk-up from worktree) |

## Exit Codes

| Code | Meaning                                                                |
| ---- | ---------------------------------------------------------------------- |
| 0    | Success                                                                |
| 1    | Contract violation (`extractResult` or `validateAgentContract` failed) |
| 2    | Config error (unknown phase/profile, missing flags) or timeout         |
| 3    | Adapter spawn failure (unexpected error)                               |

`exitCodeForOutcome` takes `Pick<AgentInvocationResult, 'outcome' | 'contractViolations'>`. When outcome is `'failed'` AND `contractViolations` includes `cancelled_by_orchestrator`, it returns exit 2 (caller-abort/timeout). All other `'failed'` outcomes return exit 3.

## Bash Invocation Pattern

```bash
_prompt_file=$(mktemp)
printf '%s' "$PROMPT" > "$_prompt_file"
NODE_OPTIONS='--conditions=development' pnpm --filter @ai-sdlc/cli exec tsx \
  "$REPO_ROOT/apps/cli/src/run-agent.ts" \
  --phase phase-name \
  --cwd "$WORKTREE_DIR" \
  --run-id "$RUN_ID" \
  --repo-id "$REPO_ID" \
  --phase-id phase-name \
  --prompt-file "$_prompt_file" \
  --timeout-minutes $(( TIMEOUT_VAR / 60 )) \
  --start-sha "$(git -C "$WORKTREE_DIR" rev-parse HEAD)" \
  --repo-root "$REPO_ROOT" \
  2>&1 | tee -a "${ISSUES_DIR}/phase-name.log"
_agent_ec=${PIPESTATUS[0]}
rm -f "$_prompt_file"

case "$_agent_ec" in
  0) ;; # success
  1) orchestrator_fail "contract violation in phase-name" ;;
  2) orchestrator_fail "config error or timeout in phase-name" ;;
  *) orchestrator_fail "adapter failure in phase-name (exit $_agent_ec)" ;;
esac
```

## Key Design Decisions

### Source-mode execution, not built artifacts

The CLI runs via `pnpm --filter @ai-sdlc/cli exec tsx` with `NODE_OPTIONS='--conditions=development'`, not `node dist/run-agent.js`. The orchestrator dev flow assumes fresh checkouts have no `dist/`. Any new package that Bash scripts invoke must support source-mode execution.

The `apps/api/package.json` exports map must include `development` conditions matching the rest of the workspace:

```json
{
  "exports": {
    "./compose.js": {
      "development": "./src/compose.ts",
      "default": "./dist/compose.js"
    }
  }
}
```

### `pnpm --filter <pkg> exec` for binary resolution

`pnpm exec` resolves from the CWD's `node_modules/.bin`. When scripts run from `$REPO_ROOT` but need a binary declared in a specific package, use `pnpm --filter @ai-sdlc/cli exec tsx`. Using bare `pnpm exec tsx` from the workspace root fails because `tsx` isn't a root dependency.

### Explicit exports, not wildcards

The initial `apps/api/package.json` had `"./*": "./dist/*"` exposing all internal modules. Only `./compose.js` is the public API surface. Use explicit single-entry exports; add subpaths as needed.

### `--prompt-file` instead of stdin

`AgentRuntimeRouter.invoke()` accepts a `promptPath` parameter. The Bash scripts already create temp files for prompts — the CLI reads from a file path rather than juggling stdin with the subprocess.

### `--repo-root` overrides `findRepoRoot()` walk-up

When `--repo-root` is provided, it overrides the walk-up directory search from `--cwd`. This is critical for worktree paths: `--cwd` is the worktree, but `orchestrator.sqlite` must write to the canonical repo root. Without `--repo-root`, invocations from worktrees write to a worktree-local database, splitting telemetry.

### Standalone invocations need a `runs` row (FK constraint)

`agent_invocations.run_uuid` has a foreign key to `runs.uuid`. The `StartIssueRun` path always creates a `runs` row, but standalone CLI invocations (e.g., from `ai-pr-review-poll`) may not have one. The CLI checks `runRepository.findByUuid(runId)` after composing the container. If no row exists, it inserts a minimal row with `issueNumber: 0`, `type: 'pr_review'`. In the `StartIssueRun` path, the row already exists and the check is a no-op.

### `RUN_ID` must reuse orchestrator UUID

Bash callers must use `RUN_ID="${AI_RUN_UUID:-${RUN_ID:-$(uuidgen ...)}}"`. `AI_RUN_UUID` is exported by `StartIssueRun`. Generating a fresh UUID causes agent invocation rows to be invisible in the `/api/runs/:uuid/invocations` endpoint.

### `--model` passthrough through the adapter

When the opencode adapter receives `request.model`, it appends `--model <model>` to the opencode argv. If this passthrough is missing, migrated phases that previously passed `--model $AGENT_MODEL` via `run_agent_raw` silently run with the default model.

### `AGENT_CLI`/`AI_RUNTIME` bypass is intentional

Migrated phases intentionally bypass the old `AGENT_CLI` env-var runtime switch. Per ADR-0007, config-driven routing via `AgentRuntimeRouter` replaces env-var-driven selection. The behavioral difference is the intended change.

## Files

| File                                                   | Purpose                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `apps/cli/src/run-agent.ts`                            | CLI entry point (~214 lines)                                                                            |
| `apps/cli/src/__tests__/run-agent.test.ts`             | Unit tests (flags, profile resolution, exit codes)                                                      |
| `apps/cli/src/__tests__/run-agent-integration.test.ts` | Integration with FakeAgentPort + FakeAgentInvocationPort                                                |
| `apps/cli/package.json`                                | ESM package, `@ai-sdlc/api` / `@ai-sdlc/domain` / `@ai-sdlc/shared` / `@ai-sdlc/infrastructure` as deps |
| `apps/api/package.json`                                | Added `development` condition exports                                                                   |

## What to Know Before Modifying

- **Adding a new phase migration:** Ensure `.ai-orchestrator.json` has a `phaseProfiles` entry, then replace `echo "$PROMPT" | run_agent_raw "phase-name" $TIMEOUT` with the Bash invocation pattern above.
- **Adding a new CLI flag:** Add to the `Flags` interface, `parseArgs` options, `validateRequiredFlags()` if required, and pass to `AgentInvocationRequest`.
- **The implement loop (M8-04):** `run_agent_raw` is still used for `implement-task-*`, `spec-review-task-*`, `quality-review-task-*`, `fix-review-task-*`. The same migration pattern applies when those are migrated.
- **`composeRoot()` side effects:** It sweeps orphaned runs/tmp dirs on every call. For the new one-per-agent-call pattern, this adds minor startup latency but is acceptable.
