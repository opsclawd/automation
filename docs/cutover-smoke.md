---
status: pending
executed_by:
executed_date:
milestone: M8-11
issue: https://github.com/opsclawd/automation/issues/452
---

# M8-11 TS Executor Cutover Smoke Test

## What to verify

- The new TypeScript executor produces identical results to the previous executor for all existing test cases.
- No regressions in executor behavior after cutover.

## How to verify

1. Run the executor test suite: `pnpm vitest run packages/application/src/executor/__tests__/`
2. Run the full CI pipeline: `pnpm test`
3. Compare output between the old (bash) and new (TypeScript) executor for at least 3 representative test cases:
   - **Test cases:** `e2e.test.ts` — specifically the cases named `"completes a full run through all 9 phases with in-memory fakes"`, `"marks run as failed when a handler returns failed outcome"`, and `"pauses run when a handler returns blocked outcome"`
   - **Old executor:** `scripts/legacy/ai-run-issue-v2` (output to `/tmp/old-executor-output.txt`)
   - **New executor:** `RunExecutor` via `pnpm vitest run --reporter=verbose packages/application/src/executor/__tests__/e2e.test.ts` (output to `/tmp/new-executor-output.txt`)
   - **Comparison:** `diff /tmp/old-executor-output.txt /tmp/new-executor-output.txt`

## Success criteria

- All executor tests pass (exit code 0).
- No unexpected errors or warnings in logs.
- Output matches expected baseline for each test case.
