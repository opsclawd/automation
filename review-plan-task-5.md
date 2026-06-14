# Review Plan: Task 5 - Fix first 6 trap EXIT violations in parse_tasks.bats

## Objective
Verify that Task 5 was implemented correctly according to the specification.

## Task 5 Requirements
Fix the first 6 `_lint_task_size` test blocks in `parse_tasks.bats` at lines 1359, 1385, 1412, 1439, 1498, 1525.

For each test block:
1. Remove the `trap "rm -rf $test_dir" EXIT` line
2. Add `rm -rf "$test_dir"` before the closing `}` of the test block

## Verification Steps

### Step 1: Read the implementation
Read `scripts/lib/__tests__/parse_tasks.bats` from line 1350 to line 1560 to examine all 6 test blocks.

### Step 2: Verify each test block
Check each of the 6 test blocks:

1. **Test 1 (line 1356)**: `_lint_task_size: returns 0 when no test files exceed thresholds`
   - Verify no `trap "rm -rf $test_dir" EXIT` line
   - Verify `rm -rf "$test_dir"` before closing `}`

2. **Test 2 (line 1383)**: `_lint_task_size: warns when test file exceeds line threshold`
   - Verify no `trap "rm -rf $test_dir" EXIT` line
   - Verify `rm -rf "$test_dir"` before closing `}`

3. **Test 3 (line 1410)**: `_lint_task_size: warns when test file exceeds test case threshold`
   - Verify no `trap "rm -rf $test_dir" EXIT` line
   - Verify `rm -rf "$test_dir"` before closing `}`

4. **Test 4 (line 1437)**: `_lint_task_size: counts multiline test declarations correctly`
   - Verify no `trap "rm -rf $test_dir" EXIT` line
   - Verify `rm -rf "$test_dir"` before closing `}`

5. **Test 5 (line 1496)**: `_lint_task_size: skips tasks with no files field`
   - Verify no `trap "rm -rf $test_dir" EXIT` line
   - Verify `rm -rf "$test_dir"` before closing `}`

6. **Test 6 (line 1524)**: `_lint_task_size: skips non-test files`
   - Verify no `trap "rm -rf $test_dir" EXIT` line
   - Verify `rm -rf "$test_dir"` before closing `}`

### Step 3: Check for remaining traps in the modified range
Run: `sed -n '1350,1555p' scripts/lib/__tests__/parse_tasks.bats | grep -c 'trap.*EXIT' || true`
Expected: 0 (no trap lines left in the first 6 test blocks)

### Step 4: Run the affected tests
Run: `bats scripts/lib/__tests__/parse_tasks.bats --filter '_lint_task_size' 2>&1 | head -40`
Expected: The first 6 tests pass

### Step 5: Write spec review results
Write findings to `/home/gary/.openclaw/workspace/automation/.ai-worktrees/issue-327/spec-review-task-5.md`
Write verdict to `/home/gary/.openclaw/workspace/automation/.ai-worktrees/issue-327/spec-review-task-5.result`

## Preliminary Observations
Based on the file read, I can already see:
- All 6 test blocks have had their trap lines removed
- All 6 test blocks have `rm -rf "$test_dir"` before their closing `}`
- Test 7 (line 1555) still has a trap, but that's Task 6's scope, not Task 5

## Expected Verdict
If all 6 tests are correctly fixed, the verdict should be SPEC_PASS.