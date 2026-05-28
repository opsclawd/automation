---
title: Route all per-task phase invocations through run-agent.ts (issue #118)
date: 2026-05-27
category: orchestrator
module: scripts
problem_type: migration
component: ai-run-issue-v2
symptoms:
  - AI_AGENT_MODEL env var ignored for implement, spec-review, quality-review, fix-review, re-review, compound, and extract phases
  - agent_invocations rows missing for per-task phases (bypassed AgentRuntimeRouter entirely)
  - Silent model fallback to opencode project-default from history (caused credits exhaustion on issue-52 runs)
root_cause: run_agent_raw bypassed AgentRuntimeRouter
resolution_type: feature
severity: high
related_components:
  - scripts/ai-run-issue-v2
  - .ai-orchestrator.json
  - apps/cli/src/run-agent.ts
  - packages/infrastructure/src/agent/agent-runtime-router.ts
tags:
  - bash-migration
  - agent-routing
  - phase-profiles
  - exit-code-mapping
  - M4-06
---

# Route All Per-Task Phase Invocations Through `run-agent.ts`

## Problem

After #52 landed `phaseProfiles` routing and `AI_AGENT_PROVIDER`/`AI_AGENT_MODEL` env-var overrides, seven per-task phase callsites in `scripts/ai-run-issue-v2` still used `run_agent_raw()`, which spawned `opencode --model $AGENT_MODEL` directly. This bypassed the router entirely:

- `run_agent_raw()` called `opencode` as a subprocess with no `AgentRuntimeRouter` in the path
- `phaseProfiles` resolution was skipped
- `AI_AGENT_MODEL` / `AI_AGENT_PROVIDER` env vars were ignored
- No `agent_invocations` rows were written for these phases
- On invalid `--model` values, opencode silently fell back to its project-default-from-history, causing a recent run to burn credits on `crofai/deepseek-v4-pro-precision`

The seven migrated phases are the highest-volume invocations: 3–10 review-fix iterations × N tasks per run.

## What Was Decided and Why

**Decision: Migrate each callsite mechanically to the existing `run-agent.ts` pattern rather than introducing a new shell wrapper.**

Approach B (thin shell wrapper `run_agent_routed()`) was rejected because:

- The existing pattern was copy-paste explicit and already worked for plan-design, plan-write, whole-pr-review, fix-review-loop
- A wrapper would create two invocation patterns where one already existed
- Savings of ~5 lines per callsite didn't justify a new abstraction

Approach C (full TypeScript rewrite of ai-run-issue-v2) was rejected as YAGNI — far beyond the scope of closing the routing gap.

**Decision: Use `--phase quality-review` for `re-review` invocations.** There is no `re-review` entry in `phaseProfiles`. Since re-review is semantically a re-run of quality review (inspector profile), `--phase quality-review` with distinct `--phase-id "re-review-${FIX_LOOP_COUNT}"` is correct. This keeps the migration scoped and avoids adding a new profile entry.

**Decision: Map exit code 124 → 2 for timeout checks.** `run_agent_raw` returned 124 on timeout; `run-agent.ts` returns 2 for config/timeout errors. Callers that checked `[[ $_ec -eq 124 ]]` now check `[[ $_ec -eq 2 ]]`. This is safe because `run-agent.ts` exit code 2 is only returned for timeout or config errors — if a config error occurred, it would have been caught at startup before the agent ran.

**Decision: `extract` phase maps to `builder` profile.** The extract phases run brief prompts to pull structured data from agent output. `builder` is the cheapest existing profile. Using `builder` avoids defining a new `opencode-fast` profile with its own `provider`/`model` fields. Operators can override via `AI_AGENT_MODEL` or by changing the profile assignment.

## Key Implementation Decisions

### 1. `--phase` vs `--phase-id` distinction

The CLI takes two related but different flags:

- `--phase`: canonical phase name used for `phaseProfiles` lookup (e.g., `implement`, `spec-review`)
- `--phase-id`: full per-invocation identifier for telemetry (e.g., `implement-task-12`, `re-review-3`)

The migration passes the canonical phase to `--phase` so profile resolution works, and the task-suffixed identifier to `--phase-id` for telemetry row identification.

### 2. Prompt file instead of stdin

`run_agent_raw` accepted prompts via `echo "$PROMPT" | run_agent_raw "phase" $timeout`. The routed pattern uses `--prompt-file` because `AgentRuntimeRouter.invoke()` expects a file path. Each callsite creates a temp file with `printf '%s' "$PROMPT" > "$_prompt_file"`, passes it, then deletes it. Using `printf` (not `echo`) avoids trailing newline interpretation in prompts.

### 3. `PIPESTATUS[0]` for exit code capture

The `! ... 2>&1 | tee ...` pipeline is negated with `!` so that non-zero exit codes propagate through the pipeline. `${PIPESTATUS[0]}` captures the actual exit code of the `node` command before the `!` negation. This is the same pattern used by the existing routed callsites (plan-design, plan-write, etc.).

### 4. Exit code handling per callsite

| Callsite            | Old exit code check                                         | New exit code check                            |
| ------------------- | ----------------------------------------------------------- | ---------------------------------------------- |
| extract             | None (warning on failure)                                   | `[[ $_agent_ec -ne 0 ]]` → warn only           |
| implement-task      | None (check_branch_after_agent)                             | `[[ $_agent_ec -ne 0 ]]` → orchestrator_fail   |
| spec-review-task    | `[[ $_ec -eq 124 ]]` (timeout → proceed if artifacts exist) | `[[ $_agent_ec -eq 2 ]]` → same artifact check |
| quality-review-task | `[[ $_ec -eq 124 ]]` (timeout → proceed if artifacts exist) | `[[ $_agent_ec -eq 2 ]]` → same artifact check |
| fix-review-task     | None                                                        | `[[ $_agent_ec -ne 0 ]]` → orchestrator_fail   |
| re-review           | None                                                        | `[[ $_agent_ec -ne 0 ]]` → orchestrator_fail   |
| compound            | None                                                        | `[[ $_agent_ec -ne 0 ]]` → orchestrator_fail   |

### 5. `check_branch_after_agent` preserved

This function is called after implement, spec-review, quality-review, and fix-review. It checks git branch state and does not depend on how the agent was invoked. The migration preserves these calls exactly — exit-code handling only affects what happens before `check_branch_after_agent`, not whether it runs.

## Gotchas and Pitfalls

**`--phase extract` requires `phaseProfiles.extract` to exist first.** `resolveProfileName()` returns an error if `--phase` doesn't match a key in `phaseProfiles`. The `.ai-orchestrator.json` change (Task 1) must land before or alongside the extract callsite migration (Task 2). If you see exit code 1 from a routed invocation, the first thing to check is whether the phase key exists in the config.

**`bash -n` must pass after every task.** A syntax error in the shell script is a stop condition. Run `bash -n scripts/ai-run-issue-v2` after each callsite migration before proceeding.

**Exit code 2 in spec-review/quality-review timeouts: proceed only if both artifacts exist.** The previous behavior checked exit 124 (raw timeout) and allowed continuation if both `.result` and `.md` files existed. This behavior is preserved: `[[ $_agent_ec -eq 2 ]]` triggers the same artifact-existence check.

**`AGENT_MODEL`/`AGENT_CLI` defaults: removed after all callsites migrate.** These were lines 52-53 in the original script. They were only safe to remove after zero `run_agent_raw` callsites remained. Removing them earlier would break any remaining raw calls.

**`TIMEOUT_*` variables are in seconds; `--timeout-minutes` expects minutes.** The migration divides by 60: `$(( TIMEOUT_IMPLEMENT / 60 ))`. All existing timeouts (1800s, 900s, 600s) divide evenly.

## Files Changed

| File                                           | Change                                                                                                                                                                                              | Purpose                           |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `.ai-orchestrator.json`                        | Added `"extract": {"profile": "builder"}` entry                                                                                                                                                     | Enables `--phase extract` routing |
| `scripts/ai-run-issue-v2`                      | Replaced 7 `run_agent_raw` callsites with `run-agent.ts` invocations; removed `run_agent_raw` function (lines 567–615) and `AGENT_MODEL`/`AGENT_CLI` defaults (lines 52–53); updated header comment | Complete routing migration        |
| `docs/quickstart.md`                           | Updated env-var table: `AGENT_MODEL` → `AI_AGENT_MODEL`, removed `AGENT_CLI` row                                                                                                                    | Documentation consistency         |
| `scripts/lib/__tests__/run-agent-routing.bats` | New test file verifying no `run_agent_raw` callsites remain, no `AGENT_MODEL`/`AGENT_CLI` defaults, all phase keys present in `phaseProfiles`, exit code 2 replaces 124                             | Regression prevention             |

## What to Know Before Modifying

### Adding a new phase to ai-run-issue-v2

If you add a new phase that calls an agent, use the Bash invocation pattern from the solution doc. The key structural elements:

```bash
_local_prompt_file=$(mktemp)
printf '%s' "$PROMPT" > "$_local_prompt_file"
! NODE_OPTIONS='--conditions=development' node --import "$_TSX_LOADER" \
  "$REPO_ROOT/apps/cli/src/run-agent.ts" \
  --phase <canonical-phase> \
  --phase-id "<phase-id-for-telemetry>" \
  --cwd "$WORKTREE_DIR" \
  --run-id "$RUN_ID" \
  --repo-id "$REPO_ID" \
  --repo-root "$REPO_ROOT" \
  --prompt-file "$_local_prompt_file" \
  --timeout-minutes $(( TIMEOUT_VAR / 60 )) \
  --start-sha "$(git -C "$WORKTREE_DIR" rev-parse HEAD 2>/dev/null || printf '0%.0s' {1..40})" \
  2>&1 | tee -a "${ISSUES_DIR}/<phase-id>.log"
_agent_ec=${PIPESTATUS[0]}
rm -f "$_local_prompt_file"
```

### Ensure the phase exists in phaseProfiles

Before using `--phase <name>`, verify that `.ai-orchestrator.json` has a `"<name>"` key inside `phaseProfiles`. If it doesn't, add one pointing to an existing profile (e.g., `"builder"`, `"inspector"`, `"reviewer"`). Without this, `run-agent.ts` returns exit code 1 (contract violation) immediately.

### Exit code mapping summary

| Exit code | Meaning                  | Typical handling                                                              |
| --------- | ------------------------ | ----------------------------------------------------------------------------- |
| 0         | Success                  | Continue                                                                      |
| 1         | Contract violation       | `orchestrator_fail` (or warn for extract)                                     |
| 2         | Config error or timeout  | Timeout-specific handling (proceed if artifacts exist) or `orchestrator_fail` |
| 3         | Unexpected adapter error | `orchestrator_fail`                                                           |

### The run_agent_raw removal is irreversible

Once the function is removed, any attempt to add a new raw agent call requires either re-adding the function or migrating to the routed pattern. There is no `run_agent_raw` fallback — all new agent invocations must go through `run-agent.ts`.
