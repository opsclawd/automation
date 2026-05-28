---
title: Migrate ai-consolidate-compound to run-agent.ts routing
date: 2026-05-28
category: orchestrator
module: scripts
problem_type: migration
component: cli
symptoms:
  - scripts/ai-consolidate-compound calls opencode directly, bypassing AgentRuntimeRouter
  - Consolidation agent invocations produce no agent_invocations row
  - Hardcoded model (minimax-coding-plan/MiniMax-M2.7) ignores phaseProfiles
  - AI_AGENT_MODEL / AI_AGENT_PROVIDER env vars have no effect on consolidation runs
root_cause: missing_routing_layer
resolution_type: feature
severity: high
related_components:
  - scripts/ai-consolidate-compound
  - apps/cli/src/run-agent.ts
  - packages/domain/src/run.ts
  - packages/infrastructure/src/sqlite/run-repository.ts
  - scripts/lib/__tests__/run-agent-routing.bats
tags:
  - cli
  - bash-migration
  - agent-routing
  - consolidate
  - run-type
  - phase-to-type
---

# Migrate `ai-consolidate-compound` to `run-agent.ts` Routing

## Problem

`scripts/ai-consolidate-compound` is a manual operator tool that consolidates per-run `compound.md` artifacts into `docs/solutions/`. Before this change, it called the agent directly via `opencode --model $AGENT_MODEL run` (legacy lines 134–142), bypassing the `run-agent.ts` router used by `ai-run-issue-v2` and `ai-pr-review-poll`. This caused three problems:

1. **No config-driven model selection** — the `phaseProfiles.compound` entry in `.ai-orchestrator.json` (mapping to `junior` with `builder` fallback) was ignored. The script hardcoded `minimax-coding-plan/MiniMax-M2.7`.
2. **No telemetry** — no `agent_invocations` row was written, making consolidation runs invisible on the dashboard.
3. **No `AI_AGENT_*` override support** — the per-run override env vars had no effect; only the legacy `AGENT_MODEL` / `AGENT_CLI` were respected.

This was the last remaining bash agent invocation bypassing the router (after `ai-pr-review-poll` was migrated in #118).

## Architecture

```
scripts/ai-consolidate-compound
  └─> pnpm --filter @ai-sdlc/cli exec tsx apps/cli/src/run-agent.ts \
        --phase compound \
        --phase-id consolidate-issues-52-118 \
        --cwd $REPO_ROOT \
        --run-id $(uuidgen) \
        --repo-id $OWNER_REPO \
        --repo-root $REPO_ROOT \
        --prompt-file $PROMPT_FILE \
        --timeout-minutes $(( TIMEOUT_SEC / 60 )) \
        --start-sha $(git rev-parse "$SINCE")
        └─> composeRoot() (from @ai-sdlc/api)
              └─> AgentRuntimeRouter.invoke()
                    ├─ Insert agent_invocations row
                    ├─ Resolve compound → junior profile from config
                    ├─ Execute adapter with model from profile
                    └─ Update invocation row with result
```

## Domain: New `consolidate` Run Type

`packages/domain/src/run.ts:17,31` — Added `'consolidate'` to both `Run.type` and `CreateRunInput.type` unions:

```typescript
// Before:
type: 'issue_to_pr' | 'pr_review';

// After:
type: 'issue_to_pr' | 'pr_review' | 'consolidate';
```

This is a type-level change only. `createRun()` defaults to `'issue_to_pr'` when `type` is omitted, so existing callers are unaffected. No SQLite schema migration was needed — the `runs.type` column is plain text, not an enum.

Downstream consumers:

- `RunRecord` in `packages/application/src/ports.ts:19` derives `type` from `Run['type']` — picks up the new member automatically.
- `RunRecord` in `packages/infrastructure/src/sqlite/run-repository.ts:29` extends `Run` — also picks it up automatically.
- The `toRecord()` function at line 207 casts `row.type as Run['type']` — accepts the new value without change.

## CLI: Phase-to-Type Mapping

`apps/cli/src/run-agent.ts:89-99` — Introduced a `PHASE_RUN_TYPE_MAP` record and `phaseToRunType()` function to decouple phase name from synthetic-row type:

```typescript
const PHASE_RUN_TYPE_MAP: Record<string, Run['type']> = {
  compound: 'consolidate',
};

export function phaseToRunType(phase: string | undefined): Run['type'] {
  if (phase) {
    const mapped = PHASE_RUN_TYPE_MAP[phase];
    if (mapped !== undefined) return mapped;
  }
  return 'pr_review';
}
```

The synthetic-row branch (lines 224–233) now calls `phaseToRunType(values.phase)` instead of an inline ternary. New phases needing a custom type only need an entry in `PHASE_RUN_TYPE_MAP`.

## Script: `run_agent()` Replacement

`scripts/ai-consolidate-compound:137-168` — Replaced the legacy `run_agent()` function with a `run-agent.ts` invocation. Key changes:

- **Removed** `AGENT_MODEL` and `AGENT_CLI` defaults (was lines 13–14). Added `TIMEOUT_SEC` (was already on line 15).
- **Self-describing `--phase-id`** — derived from input mode:
  - `consolidate-issues-52-118` (when `--issues` is used)
  - `consolidate-since-v2.3.0` (when `--since` is used, slashes replaced with dashes)
  - `consolidate-20260528T120000Z` (fallback, date-based)
- **UUID generation** — `CONSOLIDATE_RUN_ID` env var with `uuidgen`/`python3` fallback.
- **`--repo-id`** — `OWNER_REPO` env var with `gh repo view` fallback, then `local/local`.
- **`--start-sha`** — Uses `git rev-parse "$SINCE"` when `--since` is set (records the consolidation boundary in telemetry), falling back to `HEAD`.
- **`--timeout-minutes`** — Ceiling division from `TIMEOUT_SEC` ((seconds + 59) / 60).
- **Updated usage banner** — references `AI_AGENT_MODEL` / `AI_AGENT_PROVIDER` instead of legacy vars.

## Validation

All checks pass: `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm depcruise`, `pnpm test` (67 test files, 609 tests), `pnpm test:bash` (bats).

## Key Implementation Decisions

### Decision 1: New `consolidate` run type vs. reusing `pr_review`

Introduced a proper `consolidate` type rather than mislabeling rows as `pr_review`. The issue explicitly recommended against reuse: "it pays off when filtering the dashboard." Minimal cost (one-line change in domain + test) for clean telemetry separation.

### Decision 2: Extract phase-to-type mapping from inline ternary

The initial implementation had `type: values.phase === 'compound' ? 'consolidate' : 'pr_review'` inline in the synthetic-row branch. Code review identified this as brittle — every new phase would need to modify that line. Extracted `PHASE_RUN_TYPE_MAP` and `phaseToRunType()` at `run-agent.ts:89-99`. New phases only need a config entry.

### Decision 3: `--start-sha` should record the `--since` boundary

The initial implementation always used `git rev-parse HEAD` for `--start-sha`. When `--since <ref>` is provided, the consolidation boundary is more useful telemetry than HEAD. Fixed at `scripts/ai-consolidate-compound:167` to conditionally resolve the boundary SHA.

### Decision 4: `PIPESTATUS[0]` reliability with tee

The agent invocation pipes through `tee` for log capture (`run_agent "$PROMPT_FILE" 2>&1 | tee -a "$LOG_FILE"`). `PIPESTATUS[0]` is reliable here because bash evaluates both sides of the pipe before reading `PIPESTATUS`, and `tee` is a simple consumer that doesn't affect the producer's exit status.

### Decision 5: Self-describing `--phase-id`

Phase IDs like `consolidate-issues-52-118` make telemetry rows self-describing — an operator can immediately see which consolidation pass produced a row without cross-referencing logs. Slashes in `--since` refs (e.g., `v2.3.0`) are replaced with dashes to avoid filesystem path issues.

### Decision 6: Real config validation in bats tests

Unit tests for `resolveProfileName` use an in-memory test config that maps `compound` to `opencode-frontier`. The real config maps it to `junior`. Added a bats test that loads `.ai-orchestrator.json` at runtime and validates `phaseProfiles.compound` exists with a valid profile reference — catches config drift that unit tests wouldn't.

## Gotchas and Pitfalls

### Synthetic-row FK constraint

`agent_invocations.run_uuid` has a foreign key to `runs.uuid`. When `run-agent.ts` is invoked standalone (no parent `StartIssueRun`), no `runs` row exists. The CLI checks `runRepository.findByUuid(runId)` at line 224 and inserts a synthetic row with `issueNumber: 0` if missing. This pattern was established by the `ai-pr-review-poll` migration.

### Infrastructure `RunRecord` duplication

`RunRecord` is defined in both `packages/application/src/ports.ts` and `packages/infrastructure/src/sqlite/run-repository.ts`. Layer boundary rules prevent application from importing infrastructure. Both must stay in sync manually. However, since both derive `type` from `Run['type']` (application via explicit member, infrastructure via `extends Run`), the new `consolidate` value propagates to both automatically.

### `--repo-root` prevents worktree DB split

When `--cwd` is a git worktree, walking up from it may find a worktree-local `pnpm-workspace.yaml` (if the worktree has one) rather than the canonical repo root. The `--repo-root` flag overrides this walk-up, ensuring `orchestrator.sqlite` writes to the canonical repo. Without it, separate worktrees would write to separate databases, splitting telemetry.

### Profile mismatch risk

The `compound` phase maps to the `junior` profile (deepseek-v4-flash-free). The old script defaulted to `minimax-coding-plan/MiniMax-M2.7`. If the junior model is insufficient for consolidation curation, operators can override via `AI_AGENT_MODEL`. This is a conscious trade-off — the migration prioritizes routing consistency over model capability.

### `uuidgen` / `python3` dependency

UUID generation uses `CONSOLIDATE_RUN_ID` env var with `uuidgen` fallback, then `python3 -c 'import uuid; print(uuid.uuid4())'`. Both are standard on Linux. If neither is available, the script fails at agent invocation time rather than at startup.

### `OWNER_REPO` fallback for offline scenarios

When `gh` is not installed or the repo is local, `--repo-id` falls back to `local/local`. This is documented in the usage banner. It produces less useful telemetry values but avoids hard failure in offline/CI environments.

## Files

| File                                           | Purpose                                                                                               |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `packages/domain/src/run.ts`                   | Added `'consolidate'` to `Run.type` and `CreateRunInput.type` unions                                  |
| `packages/domain/src/__tests__/run.test.ts`    | Test `createRun` with `type: 'consolidate'`                                                           |
| `apps/cli/src/run-agent.ts`                    | Extracted `PHASE_RUN_TYPE_MAP` and `phaseToRunType()`; synthetic row uses mapping                     |
| `apps/cli/src/__tests__/run-agent.test.ts`     | 3 `phaseToRunType` unit tests; `compound` in test config `phaseProfiles`                              |
| `scripts/ai-consolidate-compound`              | Replaced `run_agent()`; removed `AGENT_MODEL`/`AGENT_CLI`; updated usage banner                       |
| `scripts/lib/__tests__/run-agent-routing.bats` | 12 new bats tests (syntax, no legacy calls, routing, phase-id, env vars, e2e, real config validation) |

## What to Know Before Modifying

- **Adding a new phase with a custom run type:** Add an entry to `PHASE_RUN_TYPE_MAP` in `run-agent.ts:89-91`. No other code changes needed — the synthetic-row branch and `phaseToRunType()` handle it generically.
- **Changing the `compound` profile:** Update `agent.phaseProfiles.compound` in `.ai-orchestrator.json`. The bats test at `run-agent-routing.bats:382-403` will validate that the profile reference is valid. Update that test if the profile key changes.
- **Modifying the consolidation script:** The `run_agent()` function in `scripts/ai-consolidate-compound:137-168` is the sole agent invocation point. The prompt assembly (lines 87-133), input discovery (lines 67-81), and commit logic (lines 178-208) are unchanged from the legacy script.
- **Exit code handling in bash:** Exit codes 0=success, 1=contract violation, 2=config/timeout, 3=adapter failure. The script only warns on non-zero exit (line 178-180) — it does not halt. This is intentional: the operator inspects the log and decides whether to commit.
- **`composeRoot()` side effects:** It sweeps orphaned runs and tmp dirs on every call. For the one-per-agent-invocation pattern, this adds minor startup latency but is acceptable.
