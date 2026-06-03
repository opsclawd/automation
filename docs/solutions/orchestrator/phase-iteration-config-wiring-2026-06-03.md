---
title: Wire phase iteration limits from .ai-orchestrator.json into script loops
date: 2026-06-03
category: orchestrator
module: scripts
problem_type: dead_config
component: script
symptoms:
  - .ai-orchestrator.json defines phases.reviewFix.maxIterations but the script hardcodes 5
  - .ai-orchestrator.json defines phases.implement.maxIterations but no code ever reads it
  - The whole-PR fix loop hardcodes 10 with no corresponding config key
  - Editing the config values had no effect — the operator-facing config was misleading
root_cause: missing_config_consumption
resolution_type: feature
severity: medium
related_components:
  - scripts/ai-run-issue-v2
  - packages/shared/src/config/schema.ts
  - .ai-orchestrator.json
  - scripts/lib/__tests__/phase_iteration_config.bats
tags:
  - config
  - bash
  - jq
  - dead-config
  - review-loop
  - zod-schema
---

# Wire Phase Iteration Limits from `.ai-orchestrator.json` into Script Loops

## Problem

`.ai-orchestrator.json` defines per-phase iteration limits:

```json
"phases": {
  "reviewFix": { "maxIterations": 10 },
  "implement": { "maxIterations": 5 }
}
```

The Zod schema in `packages/shared/src/config/schema.ts` validates these keys, but the shell script `scripts/ai-run-issue-v2` **never read them** (`grep -nE 'reviewFix|maxIterations' scripts/ai-run-issue-v2` → no matches). Three iteration bounds were hardcoded:

1. **Per-task review-fix loop**: `while [[ $REVIEW_LOOPS -lt 5 ]]` with `/5` in log messages and a `$REVIEW_LOOPS -ge 5` exhaustion check.
2. **Whole-PR fix-review loop**: `if [[ $FIX_LOOP_COUNT -gt 10 ]]` with `max=10` and `/10` in log strings.
3. **`phases.implement.maxIterations`**: Validated by Zod but consumed by no loop — the implement phase runs each task once.

This was surfaced during triage of **#137**, which hard-failed after the review loop hit "max 5 iterations" on task 5. The config file said `10`, so the effective limit was both wrong and untunable.

## What Was Done

1. Added a config-reading block in `scripts/ai-run-issue-v2` that reads `.ai-orchestrator.json` via `jq` and exports iteration limits as shell variables with safe defaults.
2. Replaced all hardcoded `5` references in the per-task review-fix loop with `$MAX_REVIEW_FIX_ITERATIONS`.
3. Replaced all hardcoded `10` references in the whole-PR fix-review loop with `$MAX_WHOLE_PR_FIX_ITERATIONS`.
4. Added `wholePrFix` as an optional key to the Zod `phasesSchema` in `packages/shared/src/config/schema.ts`.
5. Added `wholePrFix.maxIterations` to `.ai-orchestrator.json`.
6. Added a comment documenting `implement.maxIterations` as dead config.
7. Wrote bats tests for the config-reading block (`scripts/lib/__tests__/phase_iteration_config.bats`).

## Architecture

```
scripts/ai-run-issue-v2
  └─ Config-reading block (after log()/info() are defined)
       ├─ Defaults: MAX_REVIEW_FIX_ITERATIONS=5, MAX_WHOLE_PR_FIX_ITERATIONS=10
       ├─ If .ai-orchestrator.json exists:
       │    └─ jq '.phases.reviewFix.maxIterations // empty'  ──→ MAX_REVIEW_FIX_ITERATIONS
       │    └─ jq '.phases.wholePrFix.maxIterations // empty'  ──→ MAX_WHOLE_PR_FIX_ITERATIONS
       └─ log "Config: reviewFix.maxIterations=…, wholePrFix.maxIterations=…"
              ↓
       Per-task review-fix loop uses $MAX_REVIEW_FIX_ITERATIONS
       Whole-PR fix-review loop uses $MAX_WHOLE_PR_FIX_ITERATIONS
```

## Key Implementation Decisions

### Decision 1: Config reading via `jq`, not TypeScript

Rejected running the TypeScript config loader from the shell (`node -e 'import {loadConfig}...'`). The script already uses `jq` extensively (event log parsing, review loop history), so `jq` is an established dependency. Using it avoids a node process startup cost on every script invocation.

### Decision 2: `jq -r '… // empty'` + `2>/dev/null` for resilience

The `// empty` operator returns nothing (empty string) when a key is absent, so the `[[ -n "$_val" ]]` guard survives. The `2>/dev/null` swallows `jq` errors on malformed JSON — the TypeScript path already validates; the shell side should be resilient.

The initial implementation used `[[ -n "$_val" ]]` as the post-read guard. Code review strengthened this to `[[ "$_val" =~ ^[0-9]+$ ]]` (`scripts/ai-run-issue-v2:87`), rejecting non-numeric values that would cause unpredictable loop behavior.

### Decision 3: Block placement matters — `log()` must be defined first

The initial implementation placed the config block at line 64, before the `log()` and `info()` shell functions were defined on line 87. The startup log line (`log "Config:…"`) would have failed silently — the `log` function didn't exist yet. Code review caught this; the block was moved to after the helper function definitions (`scripts/ai-run-issue-v2:78-95`).

### Decision 4: `wholePrFix` is optional in the Zod schema

The existing `reviewFix` and `implement` keys are required. Adding `wholePrFix` as required would break all existing config files that lack it. Making it `.optional()` with a shell-side default of `10` provides backward compatibility — existing config files continue to work, and operators who add the key get explicit control.

### Decision 5: `implement.maxIterations` is dead config, documented

The implement phase runs each task once sequentially — there is no retry loop. The key validates but is never consumed. Rather than removing it (which would break existing config files) or wiring it to nothing, the schema now has a comment documenting the gap at `packages/shared/src/config/schema.ts:11-12`.

### Decision 6: Test extraction via `awk`, not sourcing the script

The bats tests (`scripts/lib/__tests__/phase_iteration_config.bats:276-285`) extract the config-reading block via `awk`, then `eval` it in an isolated environment with `REPO_ROOT` pointing to a temp directory and a stubbed `log()` function. This avoids sourcing the 3400-line script and all its state — the block is self-contained enough to test in isolation.

## Gotchas and Pitfalls

### `log()` function ordering (caught in review)

If you add code before `log()` is defined, any `log "…"` call will fail. The `info()` and `warn()` functions are also defined just before the config block. The current ordering is:

```
line 73: log() { … }
line 74: info() { … }
line 75: warn() { … }
line 78: # ── Phase iteration limits from config ──
```

### Non-integer config values

The original `[[ -n "$_val" ]]` guard accepts any non-empty string. A config value of `"five"` or `"3.14"` would silently pass through and cause the `-lt` comparison to produce a Bash error or unexpected behavior. The regex `[[ "$_val" =~ ^[0-9]+$ ]]` at lines 87-88 rejects anything that isn't a non-negative integer.

### No centralized `jq` validation for `|| exit`

If `jq` is missing from the system (despite being a pre-existing dependency), the config-reading block silently falls back to defaults. The script does not fail fast. This is intentional — the TypeScript config loader is the primary validation path — but operators should know that `jq` failures are masked.

### Whole-PR fix loop uses `-gt` not `-ge`

The per-task review-fix loop uses `-lt` for the while condition and `-ge` for exhaustion; the whole-PR fix loop uses `-gt` for the guard. Both are preserved exactly — only the hardcoded numbers were replaced with variables. The guard semantics are unchanged:

- Per-task: "loop while count < max", "if count >= max, it's exhausted"
- Whole-PR: "increment count first, then if count > max, break"

This means `MAX_WHOLE_PR_FIX_ITERATIONS=10` allows 10 iterations (counts 1-10 pass, count 11 triggers break). If you expected inclusive "10 iterations max", note the `-gt` vs `-ge` difference.

## Testing

The bats test file `scripts/lib/__tests__/phase_iteration_config.bats` (68 lines) covers 6 scenarios:

| Test | Config | Expected |
|------|--------|----------|
| defaults when config missing | no file | `MAX_REVIEW_FIX_ITERATIONS=5`, `MAX_WHOLE_PR_FIX_ITERATIONS=10` |
| reads reviewFix.maxIterations | `{maxIterations:7}` | `MAX_REVIEW_FIX_ITERATIONS=7` |
| reads wholePrFix.maxIterations | `{maxIterations:15}` | `MAX_WHOLE_PR_FIX_ITERATIONS=15` |
| falls back when wholePrFix absent | no wholePrFix key | `MAX_WHOLE_PR_FIX_ITERATIONS=10` |
| falls back on malformed JSON | `not json at all` | both defaults |
| logs effective limits | both set | log output contains both values |

## Files Changed

| File | Change | Lines Changed |
|------|--------|---------------|
| `scripts/ai-run-issue-v2` | Added config-reading block; replaced hardcoded `5` and `10` in both loops | +18, -18 |
| `packages/shared/src/config/schema.ts` | Added `wholePrFix` as optional; documented `implement` as dead config | +3 |
| `.ai-orchestrator.json` | Added `wholePrFix.maxIterations` | +1 |
| `scripts/lib/__tests__/phase_iteration_config.bats` | New test file | +68 |

## What to Know Before Modifying

- **Adding a new config-driven iteration limit**: Add a `jq` line in the config-reading block (`scripts/ai-run-issue-v2:86-88`) following the same pattern — default assignment, then `jq` with `// empty` override. The regex guard `[[ "$_val" =~ ^[0-9]+$ ]]` should always be used to reject non-integers.
- **Adding a new phase to the Zod schema**: Add it to `phasesSchema` in `packages/shared/src/config/schema.ts:8-15`. Make it `.optional()` unless you're willing to break existing config files.
- **Changing defaults**: The defaults at lines 84-85 (`5` and `10`) match the pre-existing hardcoded values. Changing them changes behavior for repos without explicit config. Update the bats tests in `phase_iteration_config.bats` accordingly.
- **The config block must be after `log()`/`info()` are defined**. If you move or refactor the script initialization section, verify the ordering constraint (currently around lines 73-78).
- **Bats tests extract via `awk`**, not by sourcing the script. If the config-reading block's structure changes (e.g., the comment delimiter or the closing `log` line), update the awk pattern in `_load_config_block()` at line 278-284 of the test file.
- **`implement.maxIterations` remains dead config**. If a future change adds a retry loop to the implement phase, wire `$MAX_IMPLEMENT_ITERATIONS` there and remove the dead-config comment from the schema.
