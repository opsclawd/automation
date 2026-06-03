---
title: Silent provider failure detection — catching LLM API errors when agents exit 0
date: 2026-06-03
category: orchestrator
module: packages/infrastructure
problem_type: bugfix
component: agent-adapters
severity: high
symptoms:
  - implement tasks silently DONE with zero file changes when provider quota is exhausted
  - fallbackProfile never engages for provider errors because adapter records outcome=success
  - reviewer tasks hard-fail on 429 with no retry backoff
root_cause: missing_feature
resolution_type: implementation
tags:
  - provider-error
  - fallback
  - quota
  - opencode-adapter
  - antigravity-adapter
  - shell-orchestrator
---

# Silent Provider Failure Detection

## Problem

When an LLM provider errors out (quota exhaustion, API errors), the agent runtime
(opencode or antigravity/agy) **exits 0** without producing meaningful output or artifacts.
The orchestrator's adapters interpret exit-0 as `outcome: 'success'`, so:

1. **Implement side**: A quota-dead provider produces zero file changes, empty stdout,
   and exit 0. The adapter records `success`. `shouldFallback` in the router sees no
   failure trigger. `resolve_result` defaults the empty result to `DONE`. The orchestrator
   proceeds as if the task was completed — burning review cycles on phantom work.

2. **Reviewer side**: The reviewer runtime hits a 429, exits 0 with no artifacts.
   `validate_review_artifacts` catches the empty `.md` → `invalid_agent_contract`.
   The old single immediate re-run hits the same 429 (quota hasn't reset in 5 seconds).
   The entire run hard-fails.

Observed on issue #172: crofai/qwen's `AI_APICallError` was swallowed, the implement
"ran" in 5 seconds producing a 0-byte log and no file changes, yet the run continued
as if it succeeded.

## Root Cause

The fallback machinery (`agent-runtime-router.ts` → `shouldFallback`) was fine — it
correctly checked outcomes against `fallbackTriggers`. But it could only act on what
the adapters reported. Two detection gaps:

### Gap 1: Adapters didn't scan for provider errors

`opencode-adapter.ts` set `outcome: 'failed'` only when:
- the **watchdog** matched a `QUOTA_PATTERNS` string (429, rate limits), or
- the process was **canceled** (timeout/abort), or
- `exitCode !== 0`.

Missing: generic LLM/API errors (`AI_APICallError`, provider error envelopes) that
don't match quota strings, and the case where opencode swallows the error and exits 0.

`external-cli-runner.ts` (used by `antigravity-adapter`) had even less: no watchdog
at all, no pattern scanning of any kind.

### Gap 2: No "no-op implement" safety net

An implement invocation that produces empty stdout **and** no git diff was indistinguishable
from a successful run that happened to produce nothing.

### Gap 3: Shell-layer DONE defaulted phantom success

`resolve_result`'s tertiary fallback wrote `"DONE"` unconditionally — turning a silent
no-op into a phantom passing task.

### Gap 4: No retry budget for transient reviewer errors

`rerun_reviewer_once` did one immediate re-run, guaranteed to fail for quota errors
("Resets in 11m25s").

## Solution Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Three Layers of Defense                  │
├─────────────────────────────────────────────────────────────┤
│  Layer 1: Provider error pattern scanning (both adapters)   │
│  ──── detect LLM API errors post-execution on exit 0       │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: No-op implement heuristic (opencode-adapter only) │
│  ──── exit 0 + empty stdout + no git diff = failed         │
├─────────────────────────────────────────────────────────────┤
│  Layer 3: Shell-layer BLOCKED default (resolve_result)      │
│  ──── implement tasks default to BLOCKED not DONE on empty  │
├─────────────────────────────────────────────────────────────┤
│  Layer 4: Reviewer retry with backoff (shell orchestrator)  │
│  ──── 30s + 60s backoff for infra errors before hard-fail   │
└─────────────────────────────────────────────────────────────┘
```

All four layers feed into the existing fallback machinery:
- `PROVIDER_ERROR` contract violation code → `provider_error` fallback trigger in router
- `NO_OUTPUT` contract violation code → triggers `contract_violation` fallback
- Reviewer retries exhaust → hard-fail (same as before, but with a real chance of recovery)

## Implementation

### Layer 1: Provider Error Pattern Detection

**File: `packages/infrastructure/src/agent/error-patterns.ts`** (new, replaces `quota-patterns.ts`)

Two pattern sets, two test functions. `PROVIDER_ERROR_PATTERNS` is a superset of `QUOTA_PATTERNS`
so the quota-specific classification still works:

```typescript
export const QUOTA_PATTERNS = [
  /Usage limit reached/i,
  /"statusCode":\s*429/,
  /rate_limit_exceeded/i,
  /quota.*exceed/i,
  /\b429\b/,
] as const;

export const PROVIDER_ERROR_PATTERNS = [
  /AI_APICallError/,
  /AI_APIConnectionError/,
  /provider.*error/i,
  /API error/i,
  /\b5\d{2}\b.*error/i,
  /RESOURCE_EXHAUSTED/,
  ...QUOTA_PATTERNS,
] as const;
```

Both `testQuotaPatterns` and `testProviderErrorPatterns` iterate line-by-line and return
the matching line or null. Loop order: outer = lines, inner = patterns (changed after review
— originally was patterns-outer / lines-inner, but that made the function stop at the
first matching pattern per-line, missing broader patterns).

**File: `packages/infrastructure/src/agent/opencode-adapter.ts`**

The outcome-determination logic was restructured. Originally inside the `try` block,
it was moved *after* the try/catch so that `endCommitSha` (computed via `git rev-parse HEAD`)
is available for the no-op heuristic. The structural change:

```
Before: try { ... outcome logic ... write stderr } catch { ... }
After:  try { ... capture outputs ... } catch { ... }
        compute endCommitSha
        outcome logic (needs endCommitSha and stderrForLog)
        write stderr (writes stderrForLog to preserve original output)
```

Key detail: a separate `stderrForLog` variable was added (review finding). The adapter
overwrites `stderr` with the error annotation (e.g. `PROVIDER_ERROR: ...`) for the
`AgentInvocationResult`, but the log file needs the *original* stderr. So `stderrForLog`
prepends the annotation to the original:

```typescript
stderr = `PROVIDER_ERROR: ${providerMatch}`;
stderrForLog = `PROVIDER_ERROR: ${providerMatch}\n${stderrForLog}`;
```

**File: `packages/infrastructure/src/agent/external-cli-runner.ts`**

Same pattern in a simpler context (no watchdog, no no-op heuristic). The post-execution
scan checks stdout+stderr for provider error patterns and classifies quota vs. generic
provider errors. Same `stderrForLog` pattern.

### Layer 2: No-op Implement Heuristic (opencode-adapter only)

```typescript
} else if (
  request.phaseId === 'implement' &&
  request.startCommitSha &&
  endCommitSha === request.startCommitSha &&
  stdout.trim().length === 0
) {
  outcome = 'failed';
  contractViolations = [CONTRACT_VIOLATION_CODES.NO_OUTPUT];
  stderr = 'NO_OUTPUT: agent exited 0 with empty stdout and no git changes';
}
```

Gated on `request.phaseId === 'implement'` so reviewers (which produce `.md` artifacts,
not git diffs) don't trigger false positives.

### Layer 3: Shell-layer BLOCKED Default

**File: `scripts/ai-run-issue-v2` — `resolve_result` function**

```bash
local effective_fallback="$fallback"
if [[ "$base_name" == implement-task-*.result && "$fallback" == "DONE" ]]; then
  effective_fallback="BLOCKED"
fi
```

The `base_name` check targets implement-task result files. The `$fallback == "DONE"` guard
preserves caller-supplied `BLOCKED` values. This is the tertiary fallback — only fires
when both the `.result` file and the extractor agent have failed.

### Layer 4: Reviewer Retry with Backoff

**File: `scripts/ai-run-issue-v2` — `rerun_reviewer_with_retry` function**

Replaced `rerun_reviewer_once` with a retry loop that classifies the failure:

1. Check stderr (`REPO_ROOT/.ai-runs/agent-artifacts/`) and the issues log for
   provider/quota error patterns using `grep -qiE`.
2. If **infra error**: retry up to 2 times with 30s / 60s backoff.
3. If **non-infra**: single immediate re-run (backward compatible, same behavior as before).

The stderr path changed during review: the original code looked in
`WORKTREE_DIR/*.stderr.log`, but by the time `rerun_reviewer_with_retry` runs, those
files may already be cleaned up. The correct path is
`REPO_ROOT/.ai-runs/agent-artifacts/*.stderr.log`, with a fallback to the issues log as
a second check.

**Call site pattern** (applied at 4 call sites):

```bash
if ! rerun_reviewer_with_retry "spec" "$TASK_NUM" ...; then
  if ! validate_review_artifacts "$spec_result" "$spec_md"; then
    orchestrator_fail "invalid_agent_contract: spec-review-task-${TASK_NUM} failed ..."
  fi
fi
```

The function returns 0 if a retry succeeded (it internally validates), so the outer
`validate_review_artifacts` is a safety net. When it returns 1 (all retries exhausted),
the caller hard-fails.

### Contract Violation Codes

**File: `packages/application/src/ports/contract-violation-codes.ts`**

Two new codes:

```typescript
PROVIDER_ERROR: 'provider_error',  // generic LLM/API error detected
NO_OUTPUT: 'no_output',            // implement agent produced nothing (no-op heuristic)
```

### Router Fallback Trigger

**File: `packages/infrastructure/src/agent/agent-runtime-router.ts`**

Three changes:

1. Added `'provider_error'` to the default `fallbackTriggers` array.
2. Added `case 'provider_error':` to the `shouldFallback` switch — checks for
   `outcome === 'failed'` AND `CONTRACT_VIOLATION_CODES.PROVIDER_ERROR` in
   `contractViolations`.
3. Added `provider_error` check to `determineTriggerReason` — checked before
   `runtime_error` so provider errors get a specific trigger reason.

## Key Design Decisions

### D1: Detection in adapters, not the router

Adapters own process execution and have access to stdout, stderr, and session logs.
The router consumes `AgentInvocationResult.outcome` and shouldn't re-parse adapter output.
This is consistent with the existing watchdog pattern.

### D2: PROVIDER_ERROR_PATTERNS is a superset of QUOTA_PATTERNS

When a quota pattern matches, the adapter annotates stderr with `QUOTA_EXCEEDED:` for
the router's `isQuotaError` check. Non-quota provider errors are classified differently
but still detected.

### D3: No-op heuristic is opencode-only, phaseId-gated

Reviewers (antigravity) don't produce git diffs — they write `.md` files. The heuristic
is gated on `request.phaseId === 'implement'` and `request.startCommitSha` being set.

### D4: Retry budget in shell layer, not TypeScript router

The shell orchestrator already owns review retry logic (`rerun_reviewer_once`).
Adding backoff there is consistent and avoids changing the router's fallback semantics
(which does one-shot fallback, not retry loops).

### D5: stderrForLog preserves original output

The `AgentInvocationResult.stderr` contains the annotation string (e.g. `PROVIDER_ERROR: ...`),
but the log file at `stderrPath` should contain the full original stderr with the annotation
prepended. This is a separate variable because multiple code paths modify `stderr` and
we need the original for the log.

## Gotchas and Pitfalls

1. **stderr vs stderrForLog**: The most subtle bug found in review. `stderr` (for the
   result object) gets overwritten with the annotation. `stderrForLog` prepends the
   annotation to the *original* stderr for the log file. Without this separation, the
   log file would lose the actual error output from the provider.

2. **endCommitSha computation must precede outcome logic**: The no-op heuristic needs
   `endCommitSha`. The original code computed it *after* the outcome block (since it
   was inside the try where the outcome logic was). Moving the outcome logic out of
   the try required hoisting `timeoutSignal` and `isCanceled` as module-local variables.

3. **Reviewer stderr path in retry function**: The original `rerun_reviewer_with_retry`
   looked for `.stderr.log` in `WORKTREE_DIR`, but by the time the function runs,
   those files may already be cleaned up by the main orchestrator loop. The correct
   path is `${REPO_ROOT}/.ai-runs/agent-artifacts/`, with the issues log as a fallback.

4. **Loop order in pattern matching**: Original implementation iterated patterns-outer /
   lines-inner. Review found this caused the function to stop at the first matching
   pattern per-line, missing patterns that could match later lines. Fixed to lines-outer /
   patterns-inner.

5. **Non-infra return path**: The first implementation of the non-infra branch in
   `rerun_reviewer_with_retry` didn't explicitly `return 0` (unlike the success branch
   in the infra path). The orchestrator then treated the return value as failure. Fixed
   by letting the non-infra path fall through to the caller's `validate_review_artifacts`
   check — the function only returns early (with 0) from the infra success path, and
   returns 1 from the infra exhaust path.

6. **Empty stdout + exit 0 + no git changes is assumed failure for implement**: This
   is safe because a real implement task always modifies files and produces log output.
   A true no-op task should return `DONE_WITH_CONCERNS` or `BLOCKED` explicitly.

## Files Changed

| File | Change |
|------|--------|
| `packages/application/src/ports/contract-violation-codes.ts` | Added `PROVIDER_ERROR` and `NO_OUTPUT` codes |
| `packages/infrastructure/src/agent/error-patterns.ts` | New file (replaces `quota-patterns.ts`) |
| `packages/infrastructure/src/agent/quota-patterns.ts` | Deleted (content moved to `error-patterns.ts`) |
| `packages/infrastructure/src/agent/opencode-adapter.ts` | Provider error scan + no-op heuristic + refactored outcome logic |
| `packages/infrastructure/src/agent/external-cli-runner.ts` | Provider error scan + stderrForLog |
| `packages/infrastructure/src/agent/agent-runtime-router.ts` | `provider_error` fallback trigger |
| `packages/infrastructure/src/agent/index.ts` | Updated re-exports |
| `packages/infrastructure/src/agent/__fixtures__/fake-opencode-provider-error.sh` | New test fixture |
| `packages/infrastructure/src/agent/__fixtures__/fake-opencode-noop.sh` | New test fixture |
| `packages/infrastructure/src/agent/__fixtures__/fake-agy-provider-error.sh` | New test fixture |
| `packages/infrastructure/src/agent/__tests__/opencode-adapter.test.ts` | 3 new tests |
| `packages/infrastructure/src/agent/__tests__/antigravity-adapter.test.ts` | 1 new test |
| `packages/infrastructure/src/agent/__tests__/router-fallback.test.ts` | 2 new tests |
| `scripts/ai-run-issue-v2` | `resolve_result` BLOCKED fallback + `rerun_reviewer_with_retry` |
| `scripts/lib/__tests__/resolve_result.bats` | 3 new tests |

## Verification

```bash
pnpm depcruise          # layer + circular-dep check
pnpm -r typecheck       # type safety
pnpm -r test -- --run   # all existing + new tests
pnpm lint               # lint
pnpm test:bash          # shell tests (bats)
```

## Modifying This Code

If you need to add new provider error patterns:

1. Edit `packages/infrastructure/src/agent/error-patterns.ts` — add regex to
   `PROVIDER_ERROR_PATTERNS` or `QUOTA_PATTERNS` as appropriate.
2. The test functions iterate line-by-line, so patterns should match something
   you'd find on a single line of stderr.
3. Add a test fixture script that produces the pattern and verify both the adapter
   test and the router fallback test pass.

If you need to add a new contract violation code:

1. Add to `packages/application/src/ports/contract-violation-codes.ts`.
2. Add a corresponding case in `agent-runtime-router.ts`'s `shouldFallback` switch.
3. Wire detection in the appropriate adapter(s).
4. The test pattern is: fixture script → adapter test → router test.

If modifying the reviewer retry logic:

1. The function lives in `scripts/ai-run-issue-v2` as `rerun_reviewer_with_retry`.
2. The `REVIEWER_PROVIDER_ERROR_PATTERNS` grep pattern is duplicated from
   `error-patterns.ts` — update both if error patterns change.
3. The stderr path is `${REPO_ROOT}/.ai-runs/agent-artifacts/` — not `WORKTREE_DIR`.
4. The function is called at 4 call sites (spec/quality × initial/re-review).
