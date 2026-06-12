# Spec vs Implementation Review: Task 3

**Spec**: Introduce `ESCALATION_BUDGET`, refactor retry loop and `verifyOrphaned`
**File**: `apps/api/src/process-pr-review-comments.ts`
**Test file**: `apps/api/src/process-pr-review-comments.test.ts`

## Summary

The core behavior changes are implemented correctly. However, two issues prevent this from fully satisfying the spec:

1. **Unplanned structural change to break condition** (Step 2 violation)
2. **Incomplete test updates** (Step 4/5 violations)

---

## Finding 1: Break condition changed beyond a rename (Step 2)

**Plan**: "No structural change needed here beyond the rename."

**Actual**: Line 184 changed from:
```ts
if (lastOutput.action !== 'failed') break;
```
to:
```ts
if (lastOutput.processed || lastOutput.action === 'blocked') break;
```

This is a functional change, not just a rename. The old condition broke the loop on any success (`fixed`, `replied`, etc.) or any blocked comment. The new condition only breaks when:
- The task was successfully processed (`processed === true`), OR
- The action was `blocked`

This means verification failures (where `action === 'fixed'` but `processed === false`) now continue to the next attempt instead of breaking the loop. This is *functionally necessary* for `ESCALATION_BUDGET` to work correctly in the verification-failure case, but it was not described or requested in the spec.

**Impact**: Multiple tests fail because they expected the old immediate-break behavior. The 12 test failures are all downstream of this change (and the `verifyOrphaned` refactor).

---

## Finding 2: Test assertions not updated for new behavior (Steps 4 & 5)

**Spec Step 4**: Update tests for new behavior.
**Spec Step 5**: `Expected: PASS`

12 of 32 tests fail. Key examples:

### Example A: Cross-poll verification test (line 282)

The test `'blocks a comment when verification fails (build failed)'` at line 282 expects:
```ts
expect(repo.getComment(runId, 9001)?.state).toBe('replied'); // after poll 1
```

With `ESCALATION_BUDGET=3` and 2 agent results in the queue, attempt 3 exhausts the queue (FakeAgentPort throws), the catch block sets `action: 'failed'`, and the budget exhaustion check triggers `blockComment()`. Comment state is `'blocked'` after poll 1 — not `'replied'`.

### Example B: C1 test (line 1373)

Test expects `verifyCalls.length === 2` but the refactored `verifyOrphaned` no longer calls `verifyCommitPushed` in the same way, producing only 1 call.

---

## Verdict

**SPEC_PARTIAL**

| Step | Result |
|------|--------|
| 1. Replace constants with ESCALATION_BUDGET | PASS |
| 2. Block on exhaustion (renames only) | PARTIAL — unplanned structural change to break condition |
| 3. Refactor verifyOrphaned, remove resetForRetry | PASS |
| 4. Update tests | FAIL — some assertions not updated |
| 5. Tests pass | FAIL — 20/32 pass (12 failures) |
