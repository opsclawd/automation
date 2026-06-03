---
title: Distinguish agent timeout from genuine BLOCKED in PR review poll
date: 2026-06-03
category: orchestrator
module: scripts
problem_type: conflated-terminal-state
component: ai-pr-review-poll
symptoms:
  - Agent timed out (exit code 2) but poll loop treated result as BLOCKED and exited
  - Poll abandoned remaining retry budget (28 of 30 total polls) on a retriable failure
  - LLM extractor classified crash output (pnpm error text) as BLOCKED
root_cause: extractor_runs_on_crash_output
resolution_type: bugfix
severity: high
related_components:
  - scripts/ai-pr-review-poll (resolve_result function, lines 256-287)
  - scripts/lib/result-resolver.sh (shared helper, extracted during this fix)
  - scripts/lib/__tests__/resolve-result-agent-ec.bats
tags:
  - resolve_result
  - extractor
  - exit-codes
  - poll-loop
  - bats
  - shellcheck
  - shared-lib
---

# Distinguish Agent Timeout from Genuine BLOCKED in PR Review Poll

## Problem

In PR #183, the `process-review` agent timed out (9-minute budget exhausted, exit code 2),
but the poll loop treated the result as `BLOCKED` and exited immediately, abandoning
remaining poll budget (28 of 30 total polls). Review comments were never addressed.

### Failure Chain

1. **Agent timed out** — `tsx run-agent.ts` exited code 2 (timeout/cancellation exit code).
   `pnpm` wrapped this and exited 1.

2. **Extractor mis-classified the result** — No `.result` file was written (agent didn't
   finish). The extractor ran, read `process-review-p2.log` containing only the 3-line
   pnpm crash output (`ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL`), and returned `BLOCKED`.

3. **BLOCKED treated as terminal** — `BLOCKED_EXIT=true` triggers an unconditional `break`
   at line 1056, exiting the loop regardless of remaining budget.

### Resolution Surface

The `resolve_result` function (`scripts/ai-pr-review-poll:256-287`) uses three tiers:

1. **Result file** — read `.result` file written by the agent
2. **Extractor** — LLM-based extraction from the agent log (a separate Bash function
   that invokes the extract agent)
3. **Fallback** — hard-coded fallback value passed by caller

The fallback for `process_reviews` was already `PARTIAL` (retriable). But the extractor
runs *before* the fallback, and given crash/pnpm output it would nondeterministically
return `BLOCKED`, short-circuiting the retriable fallback.

## What Was Decided

**Skip the extractor entirely when the agent exited non-zero.** When the agent
crashes or times out, fall through to the hard-coded fallback (`PARTIAL`) instead
of letting the LLM extractor guess the outcome from crash output.

Rationale:

- The extractor was designed to disambiguate *successful* agent runs where the
  agent forgot to write a result file — not to classify crash output.
- A non-zero exit code already signals abnormal outcome. The hard-coded fallback
  `PARTIAL` correctly means "something went wrong, retry."
- The LLM cannot reliably distinguish timeout from BLOCKED when given only pnpm
  crash output — its output is nondeterministic.
- Only the agent itself should declare BLOCKED (by writing it to the `.result` file).
  Crash/timeout should never become BLOCKED by inference.

### Trade-offs Considered

| Option | Verdict | Reason |
|--------|---------|--------|
| A: Change fallback from PARTIAL to something else | Rejected | The fallback was already PARTIAL — the problem was the extractor running before it |
| B: Make BLOCKED non-terminal in the main loop | Rejected | Genuine BLOCKED (agent wrote it to .result) SHOULD be terminal — preserving that was a requirement |
| C: Detect exit code 2 specifically in the poll script | Rejected | Too narrow — any non-zero exit (1=contract violation, 2=timeout, 3=spawn failure) should skip the extractor |
| **D: Skip extractor on any non-zero agent exit** | **Chosen** | Correct, minimal, preserves architecture — the extractor's contract narrows to "disambiguate successful runs with missing result files" |

## Implementation

### `scripts/ai-pr-review-poll` — `resolve_result`

Added optional `--agent-ec` parameter parsing. When present and non-zero,
sets `_skip_extractor=true`:

```bash
local _skip_extractor=false
if [[ "${all_args[0]}" == "--agent-ec" ]]; then
  local _aec="${all_args[1]:-}"
  if [[ "$_aec" != "0" ]]; then
    _skip_extractor=true
  fi
  allowed_arr=("${all_args[@]:2:$(( ${#all_args[@]} - 3 ))}")
fi
```

The extractor block is now gated: if `_skip_extractor` is true, it logs
"Agent exited non-zero; skipping extractor, using fallback" and falls through
to the fallback.

### `scripts/ai-pr-review-poll` — Call site

Added `--agent-ec "$_agent_ec"` before the allowed-values array:

```bash
review_result=$(resolve_result \
  "$_result_file" \
  "${ISSUES_DIR}/process-review-p${POLL_COUNT}.log" \
  --agent-ec "$_agent_ec" \
  ALL_DONE NO_FIXES_NEEDED PARTIAL BLOCKED \
  PARTIAL)
```

### `scripts/lib/result-resolver.sh` — Shared helper extraction

During review, the `read_result_value` and `validate_result_file` helper
functions were duplicated in both `ai-pr-review-poll` and `ai-run-issue-v2`.
Extracted them into a shared library `scripts/lib/result-resolver.sh` sourced
by both scripts. Each bats test file sources the shared lib directly and only
extracts the function under test via awk.

### Bats tests — `scripts/lib/__tests__/resolve-result-agent-ec.bats`

Six tests covering all `--agent-ec` scenarios:

| Test | Agent EC | Result file | Expected outcome |
|------|----------|-------------|------------------|
| `agent ec=0, no result file: extractor runs normally` | 0 | missing | Extractor runs, returns BLOCKED |
| `agent ec non-zero, no result file: extractor skipped, fallback used` | 1 | missing | Fallback PARTIAL, extractor NOT called |
| `agent ec non-zero, result file exists: result file honored regardless` | 1 | BLOCKED | Result file read (BLOCKED), extractor NOT called |
| `agent ec non-zero, result file has valid value: returns file value` | 2 | ALL_DONE | Result file read (ALL_DONE) |
| `no --agent-ec, no result file: extractor runs (backward compat)` | absent | missing | Extractor runs (unchanged behavior) |
| `no --agent-ec, no result file, no source file: fallback used` | absent | missing | Fallback PARTIAL (no source to extract from) |

The test stub `extract_result` writes a sentinel file (`extractor_called`)
so tests can assert whether it was invoked.

## Gotchas and Lessons Learned

### 1. String comparison safety for `$_aec`

**The one-shot bug.** The initial implementation used:
```bash
local _aec="${all_args[1]}"
if [[ "$_aec" -ne 0 ]]; then
```
This works when `--agent-ec` is always followed by a number, but if the value
is ever empty (missing argument), the `-ne` operator in `[[ ]]` produces a
syntax error. The fix was two changes:
```bash
local _aec="${all_args[1]:-}"    # default to empty string
if [[ "$_aec" != "0" ]]; then    # string comparison, not arithmetic
```
Using `!= "0"` (string comparison) instead of `-ne 0` (integer comparison)
handles empty, missing, or non-numeric values gracefully — only the literal
string `"0"` passes the gate.

### 2. Result file is always authoritative, even on crash

The tier-1 check (`validate_result_file`) runs *before* the `_skip_extractor`
gate. If the agent wrote `BLOCKED` to the `.result` file *before* crashing,
the file check returns BLOCKED correctly. The skip-extractor path is only
reached when the result file is missing or invalid. This means a genuine
agent-declared BLOCKED still terminates the loop — only inferred BLOCKED
(from crashed logs) is suppressed.

### 3. Extractor stubbing in bats tests

The test doubles for `extract_result` and `log` are defined *after* the awk
extraction of `resolve_result`. If they were defined before, they'd be
overwritten by the awk output (which prints the real function bodies).
Order matters: source shared lib, extract function via awk, then define stubs.

### 4. Shared library extraction was opportunistic

The `read_result_value` / `validate_result_file` duplication was known but
low-priority. The review for this fix flagged it and the extraction happened
in the same commit as the review fix. This is worth doing early when adding
new test files that need these helpers.

### 5. `--agent-ec` order in argument parsing matters

The `--agent-ec` flag must appear *before* the allowed-values array in the
argument list (it's parsed as the first element of `all_args`). The call site
inserts it between `source_file` and `ALL_DONE`. The array slicing is:

- Without `--agent-ec`: `allowed_arr = all_args[0 .. -2]`, `fallback = all_args[-1]`
- With `--agent-ec`: `allowed_arr = all_args[2 .. -3]`, `fallback = all_args[-1]`

The shifted indices account for the two extra `--agent-ec` and `<value>` args.

## Modifying This Code

### Where to find things

- **`resolve_result` function**: `scripts/ai-pr-review-poll:262-298` — Bash function
- **Shared helpers**: `scripts/lib/result-resolver.sh` — `read_result_value`, `validate_result_file`
- **Tests**: `scripts/lib/__tests__/resolve-result-agent-ec.bats`
- **Existing resolve_result tests**: `scripts/lib/__tests__/resolve_result.bats` (sources from `ai-run-issue-v2`)
- **Contradiction retry tests**: `scripts/lib/__tests__/contradiction_retry.bats` (also uses shared lib)

### What to know before touching

- If you add a new parameter to `resolve_result`, update the array slicing
  logic (`allowed_arr` and `fallback`) and the awk extraction regex in all
  three test files.
- The `source "$SHARED_LIB"` line in tests must come *before* the awk
  extraction of `resolve_result` (because `resolve_result` calls
  `validate_result_file` and `read_result_value`).
- New tests should stub `extract_result` and `log` as Bash functions after
  awk extraction. Use a sentinel file to assert whether the extractor was
  called (see `$TMPDIR_TEST/extractor_called` pattern).
- The `--agent-ec` parameter is optional and defaults to not skipping the
  extractor. Existing callers that don't pass it see no behavior change.
- To run just these tests: `pnpm test:bash scripts/lib/__tests__/resolve-result-agent-ec.bats`

### Safety invariants

1. The `.result` file is always authoritative — tier-1 check fires before the
   skip-extractor gate.
2. Agent exit code 0 never skips the extractor, even if `--agent-ec 0` is passed.
3. Absent `--agent-ec` preserves pre-existing behavior (backward compatible).
4. Any non-zero exit code (1, 2, 3, 137, 143, etc.) skips the extractor.
