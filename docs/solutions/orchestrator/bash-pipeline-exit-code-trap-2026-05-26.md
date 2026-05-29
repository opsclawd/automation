---
title: Bash pipeline exit code trap — PIPESTATUS[0] vs $? and full exit code handling
date: 2026-05-26
category: orchestrator
module: scripts
problem_type: bash-footgun
component: pipeline-exit-codes
symptoms:
  - Bash error handling silently never fires after adding | tee to a command
  - Exit code 0 replaces the real exit code when piping to tee
  - Non-zero exit codes from CLI tools ignored by Bash callers
root_cause: bash_pipeline_semantics
resolution_type: pattern
severity: high
related_components:
  - scripts/ai-run-issue-v2
  - scripts/ai-pr-review-poll
  - apps/cli/src/run-agent.ts
tags:
  - bash
  - pipeline
  - exit-codes
  - pipestatus
  - error-handling
---

# Bash Pipeline Exit Code Trap — PIPESTATUS[0] vs $? and Full Exit Code Handling

## Problem 1: `$?` Returns Last Pipe Stage, Not the Command

When a command is piped to `tee` for log capture:

```bash
node ... run-agent.js ... 2>&1 | tee -a "phase.log"
_agent_ec=$?
```

`$?` returns the exit code of `tee` (always 0), not `node`. The caller's error-handling path never fires.

### Fix

```bash
node ... run-agent.js ... 2>&1 | tee -a "phase.log"
_agent_ec=${PIPESTATUS[0]}
```

`PIPESTATUS[0]` is the exit code of the first command in the pipeline. `PIPESTATUS` is a Bash array; `${PIPESTATUS[0]}` is the only reliable way to get the first command's exit code when piping.

### Why This Is a Systematic Footgun

1. `ai-run-issue-v2` already used `PIPESTATUS[0]` correctly. `ai-pr-review-poll` used `$?` after the same `| tee` pattern. The inconsistency was introduced fresh during migration.
2. Adding `| tee` to an existing command that used `$?` silently breaks error handling. The command still runs, logs still capture, but failures are invisible.
3. Shellcheck can catch this (`SC2009` and related), but the repo's Bash scripts don't run shellcheck in CI.

## Problem 2: Partial Exit Code Handling Masks Failures

When the CLI defines a documented exit code contract (0/1/2/3), Bash callers must handle the full range:

```bash
# WRONG — only handles exit 2
if [[ $_agent_ec -eq 2 ]]; then
  orchestrator_fail "timeout or config error"
fi
# Falls through silently on exit 1 (contract violation) or exit 3 (adapter failure)
```

### Fix

```bash
case "$_agent_ec" in
  0) ;; # success
  1) orchestrator_fail "contract violation in phase-name" ;;
  2) orchestrator_fail "config error or timeout in phase-name" ;;
  *) orchestrator_fail "adapter failure in phase-name (exit $_agent_ec)" ;;
esac
```

Every non-zero exit must trigger `orchestrator_fail`. Without the `case` statement, stale artifacts from previous runs (e.g., `design.md`, `plan.md`) could cause the phase to progress on bad output.

## Problem 3: `PIPESTATUS[0]` Is Unreliable When the Left Side Involves a Subshell

When the left side of a pipeline involves a subshell (pushd/popd, command substitution), `PIPESTATUS[0]` carries the exit code of the subshell wrapper, not the actual command:

```bash
# WRONG — PIPESTATUS[0] carries exit code of pushd wrapper, not tsx
pushd "$REPO_ROOT" > /dev/null
pnpm exec tsx run-agent.ts ... 2>&1 | tee -a "$output_log"
_agent_ec=${PIPESTATUS[0]}   # always 0 (pushd succeeded)
popd > /dev/null
```

### Why This Happens

`pushd` and `popd` execute in a subshell context when part of a pipeline. Bash evaluates the left side of a pipe in a subshell; `PIPESTATUS[0]` returns the exit code of that subshell, not the last command within it. If `pushd` succeeds (always 0 unless dir missing), `PIPESTATUS[0]` is 0 even if the `pnpm` command fails.

### Fix: Temp File for Exit Code

```bash
pnpm exec tsx run-agent.ts ... 2>&1 | tee -a "$output_log"
echo ${PIPESTATUS[0]} > "$_pnpm_ec_file"
...
_agent_ec=$(cat "$_pnpm_ec_file")
```

The `PIPESTATUS[0]` capture and `echo` to temp file happen in the same process context — no subshell wrapper. The `_agent_ec` is read later from the file.

### Why This Is a Systematic Footgun

1. The `pushd/popd` pattern is common when running `pnpm --filter` from a worktree that lacks its own `node_modules` — the worktree has the source but not the dependencies, so the command must run from `$REPO_ROOT`.
2. `PIPESTATUS[0]` works correctly in simple pipes (`cmd | tee`). It breaks silently when the left side involves command substitution, `pushd`/`popd`, or any construct that creates a subshell.
3. Shellcheck does not reliably catch this pattern.

### Detection

```bash
grep -n 'PIPESTATUS\[0\]' scripts/*.sh | grep -B1 'pushd\|popd'
```

Lines where `PIPESTATUS[0]` is used inside a `pushd`/`popd` or similar subshell-wrapping construct are likely broken. The fix is to use a temp file for exit code capture.

## Rules

1. **Any command piped to `tee` or any multi-stage pipeline must use `PIPESTATUS[0]`**, never `$?`.
2. **When a called tool defines exit code semantics, the Bash caller must handle every documented code.** Partial handling is a regression — the old pattern (`run_agent_raw` with `$?` directly) caught all non-zero exits by default.
3. **When adding `| tee` to an existing command, update the exit code capture in the same commit.** This is the most common way to introduce this bug.
4. **`PIPESTATUS[0]` is unreliable when the left side of a pipe involves a subshell** — always use a temp file for exit code capture in that case.
5. **Search all call sites** when fixing a `$?` vs `PIPESTATUS[0]` issue. The same pipeline pattern may exist in multiple scripts.

## Detection

### `$?` vs `PIPESTATUS[0]` after `| tee`

```bash
grep -n '| tee' scripts/*.sh | grep -v 'PIPESTATUS'
```

Lines that pipe to `tee` but don't use `PIPESTATUS` are likely broken.

### Subshell-masked `PIPESTATUS[0]`

```bash
grep -n 'PIPESTATUS\[0\]' scripts/*.sh | grep -B1 'pushd\|popd'
```

Lines where `PIPESTATUS[0]` appears inside a pushd/popd or similar subshell context — these need the temp-file workaround.
