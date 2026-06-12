---
type: code-review
scope: task-3
run_id: task-3-pr-review
created_at: "2026-06-10T22:10:00Z"
verdict: REJECT
---

# Task 3 Code Review — Unplanned Semantic Change in Break Condition

## Summary

Task 3 has **3 tests still failing** out of 342, caused by an **unplanned semantic change** to the break condition at `process-pr-review-comments.ts:184`. The commit (`ed0ad26`) introduced a break condition that differs from the original code and the plan's intent. The plan explicitly says "No structural change needed here beyond the rename" for the task loop — but the break condition was semantically altered.

## Unplanned Break Condition Change

**The issue:** The break condition at line 184 was changed from breaking on ANY non-failed action to only breaking on `processed || blocked`:

**Original (correct):**
```typescript
if (lastOutput.action !== 'failed') break;
```

**Current (broken):**
```typescript
if (lastOutput.processed || lastOutput.action === 'blocked') break;
```

**Plan Step 2 says:** "The task loop is already the site where blocking happens for agent-invocation exhaustion. **No structural change needed here beyond the rename.**"

### Why the current code fails

PollTaskRunner returns different shapes depending on failure type:
- **Agent invocation failure:** `{ action: 'failed' }` → no `processed`/`blocked` fields
- **Verification failure:** `{ action: 'fixed'|'no_fix', processed: false, blocked: false }`

The original condition `action !== 'failed'` correctly broke on verification failures (leaving comment in 'replied' state for cross-poll handling). The new condition `processed || action === 'blocked'` does NOT break on verification failures — it retries them within the task loop, burning through ESCALATION_BUDGET and blocking prematurely.

## Failing Tests (3 of 342)

### 1. happy path (line 314-340)
**Error:** `Expected 'blocked' to be 'replied'`
**Cause:** `makeDeps()` uses `IncrementingShaGitPort` with no `ancestorResults` setup. `isAncestor` returns `false`, verifyComment returns `{ok: false}`. New break condition retries verification failures → comment gets blocked in task loop.
**Fix:** Revert break condition + add `ancestorResults` setup in makeDeps for the happy path SHA.

### 2. blocking (line 342-363)
**Error:** `Expected 'blocked' to be 'replied'`
**Cause:** Same as above — verification failure retries in task loop instead of breaking.
**Fix:** Revert break condition.

### 3. C1 rejects different agent's push (line 1414-1445)
**Error:** `Expected 1 to be 2` (verifyCalls.length)
**Cause:** agentA's verification failure retries in task loop, blocks before agentB is processed.
**Fix:** Revert break condition.

## Fix Required

The break condition at `process-pr-review-comments.ts:184` needs to be reverted to match the original behavior:

```typescript
if (lastOutput.action !== 'failed') break;
```

This ensures verification failures break the loop (leaving comment in 'replied' state), while only agent invocation failures (`action === 'failed'`) trigger retries within the task loop. This matches the plan's intent and the design's cross-poll verification model.

## Verification

After fixing, run:
```bash
pnpm test -- --filter orchestrator
```

The 3 remaining failures should resolve. If makeDeps also needs `ancestorResults` for the happy path SHA (12 total tests fail without this), add:
```typescript
ancestorResults: new Map([[incrementSha(SHA), true]])
```
to makeDeps.
