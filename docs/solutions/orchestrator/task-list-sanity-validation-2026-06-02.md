---
title: Task list sanity check — validating parsed plan tasks before implementation
date: 2026-06-02
category: orchestrator
module: scripts/lib/parse_tasks_helpers.sh
problem_type: defense-in-depth
component: task-parsing
symptoms:
  - Orchestrator parses phantom tasks from example headers or fenced fixtures
  - Silent corruption of worktree before anything notices the count is wrong
  - Implementer hits a "Task N: Phantom" and returns NEEDS_CONTEXT (or hallucinates work)
root_cause: no_validation_ground_truth
resolution_type: pattern
severity: high
related_components:
  - scripts/ai-run-issue-v2
  - scripts/lib/parse_tasks_helpers.sh
  - scripts/lib/__tests__/parse_tasks.bats
tags:
  - bash
  - sanity-check
  - task-parsing
  - validation
  - plan
---

# Task List Sanity Check — Validating Parsed Plan Tasks Before Implementation

## Problem

The orchestrator builds its task list by scraping `## Task N:` headers from `plan.md` via `parse_tasks()` in `scripts/lib/parse_tasks_helpers.sh`. This list drives the entire implement phase: iteration, checkpointing, resume detection, and PR task-list generation. When the parsed count is wrong, the orchestrator silently proceeds into phantom tasks and corrupts the worktree.

Two concrete failures drove this work:

- **#168**: parsed 11 tasks (5 real + 6 example headers in validation sections) — halted on phantom "Task 8: Validate the data migration output".
- **#172**: parsed **49** tasks (10 real + 39 fenced fixtures) — would have ground through "Task 2: Phantom", etc.

The fence-aware parser (`_strip_fenced`) from #172 prevents fenced code blocks from being scraped, but the root cause — **no validation of the parsed list against any ground truth** — remained. Any future parser regression or novel plan format produces the same silent corruption.

## Solution

Add `validate_task_list()` — a Bash function that runs once after `parse_tasks`, cross-checking the parsed list against a declared task count and structural heuristics.

### Four Checks

| Check | What it does | Blocking? | Example failure |
|---|---|---|---|
| **Count cross-check** | Parse `<!-- task-count: N -->` from plan.md, compare to parsed count | Yes | `parsed 49 tasks but plan declares 10` |
| **Sequential numbering** | Verify task numbers form 1..N with no gaps, duplicates, or out-of-order | Yes | `task numbers are not sequential: found [1,3], expected 1..2` |
| **Duplicate titles** | Flag case-insensitive duplicate titles | Yes | `duplicate task titles detected: 'Implement X' appears 2 times` |
| **Fixture-title heuristic** | Match titles against known fixture patterns (Phantom, Real task, etc.) | No (advisory warning) | Warning logged, run continues |

### Declared Count Mechanism

The plan-write prompt (`PLAN_WRITE_PROMPT` in `ai-run-issue-v2` line ~1129) now requires:

```
- The plan MUST include a <!-- task-count: N --> HTML comment immediately before the first task header
```

**Why an HTML comment**: invisible in rendered Markdown, machine-parseable, doesn't interfere with plan readability. No new files or manifests needed.

**Fallback**: if the comment is absent (legacy plans), a warning is emitted and the count cross-check is skipped. The other three checks still run.

### Wiring

In `scripts/ai-run-issue-v2` at line 1948, immediately after the zero-count check:

```bash
_validation_error=$(validate_task_list "plan.md" "$TASK_COUNT")
if [[ -n "$_validation_error" ]]; then
  orchestrator_fail "$_validation_error"
fi
```

`validate_task_list` returns error strings (non-empty on failure) instead of calling `orchestrator_fail` directly. This keeps it testable in bats without triggering `exit 1`.

### File Layout

All validation logic lives in `scripts/lib/parse_tasks_helpers.sh`:
- `_extract_declared_count` — extracts `<!-- task-count: N -->` from the preamble before the first task header, not from the entire document (lines 13-22)
- `_check_sequential_numbers` — extracts task numbers from fence-stripped headers (lines 20-49)
- `_check_duplicate_titles` — case-insensitive duplicate detection via awk/grep (lines 51-69)
- `_check_fixture_titles` — substring match against curated fixture pattern array (lines 71-94)
- `validate_task_list` — orchestrator that runs all checks in order (lines 96-145)

Tests in `scripts/lib/__tests__/parse_tasks.bats` — 17 new test cases covering all helpers and integration tests.

## Key Implementation Decisions

### 1. The task-count comment is scoped to the preamble before the first task header

The prompt now contains the literal `<!-- task-count: N -->` marker in its instructions, so a plan may include prose examples referencing the marker. To prevent a prose example like `<!-- task-count: 99 -->` from being matched, `_extract_declared_count` scopes its search to lines before the first `## Task N:` header (after fence-stripping). It picks the **last** match in that preamble (i.e., the one immediately before the tasks), using `tail -1`:

```bash
header_line=$(_strip_fenced < "$plan_file" | grep -nP '^#{2,3} Task \d+:' | head -1 | cut -d: -f1)
count=$(_strip_fenced < "$plan_file" | head -n "$((header_line - 1))" | grep -oP '<!--\s*task-count:\s*\K[0-9]+' 2>/dev/null | tail -1)
```

This also handles flexible whitespace (`\s*`) in the HTML comment attribute.

### 2. Sequential numbering checks original order, not sorted order

The function builds the expected sequence `1 2 3 ... N` and compares it against the **original parse order** (not sorted). This catches out-of-order task numbers, which sorted comparison would miss:

```bash
original=$(echo "$numbers" | tr '\n' ' ')  # not sorting
if [[ "$original" != "$expected" ]]; then
```

### 3. Fixture patterns must be a Bash array, not a space-separated string

Multi-word patterns like "Real task" or "Fix failing tests" break when iterated as a plain string (`for pattern in $fixture_patterns`). The fix was to use an actual Bash array and iterate with `"${fixture_patterns[@]}"`.

### 4. Duplicate title detection preserves original casing in error messages

The awk call detects duplicates in lowercase, but the error message shows the original casing by grepping the task list case-insensitively:

```bash
original_casing=$(echo "$task_list" | grep -ixm 1 "$first_dup" || true)
```

The `-x` flag (exact line match) prevents partial matches from producing wrong casing in the error.

### 5. Tests must stub `emit_event` and use `set +e`

- `validate_task_list` calls `emit_event` for warnings/info events. In bats, `emit_event` is not available unless stubbed: `emit_event() { true; }`.
- Tests expecting non-zero return codes need `set +e` / `set -e` wrapping because bats runs with `set -e` by default.

### 6. Check ordering matters

The count cross-check runs first because it's the cheapest and catches the #168/#172 class of bugs immediately. Sequential numbers run second (still cheap, catches malformed task definitions). Duplicate titles and fixture warnings run last (require re-parsing the task list via `parse_tasks`).

## Gotchas and Pitfalls

### The plan-write prompt is also in ai-run-issue-v2

Two prompt locations were updated: the bullet list of requirements (line ~1129) and the existing example-header warning (line ~1141). The example-header warning references the HTML comment convention so the agent connects the two concerns.

### Git commits and the review loop

The implementation was split across 5+ commits (one per task). Task 4 (duplicate/fixture helpers) went through 2 review loops:
1. First loop caught the Bash array vs string issue in `fixture_patterns` and the awk variable efficiency
2. The final loop added edge-case tests (out-of-order numbers, flexible whitespace in HTML comment, multi-word fixture patterns, original casing in error messages)

### Emit event payload conventions

Validation events use dot-separated event names under the `sanity_check.*` namespace:
- `sanity_check.missing_declared_count` — warning when `<!-- task-count: N -->` absent
- `sanity_check.fixture_title` — advisory warning for fixture-like titles
- `sanity_check.passed` — info event on successful validation

Events include `declaredCount` and `parsedCount` as structured data keys for observability.

### Tests to run after changes

```bash
pnpm test:bash                              # all bats tests
pnpm test:bash -- -f 'validate_task_list'   # integration tests only
bash -n scripts/lib/parse_tasks_helpers.sh  # syntax check
bash -n scripts/ai-run-issue-v2             # syntax check
```

## What to Know When Modifying

- **Adding a new fixture pattern**: Edit the `fixture_patterns` array in `_check_fixture_titles()` in `parse_tasks_helpers.sh:73`. Add a corresponding test in the bats file.
- **Changing check order**: Update the sequence inside `validate_task_list()`. The count cross-check should stay first (degenerate case).
- **Adding a new check**: Define a helper function, add a test block, and insert the call in `validate_task_list()` between the existing checks. Follow the emit_event pattern for observability.
- **The fence-aware parser is NOT touched by this change**. If `_strip_fenced` changes, the validation functions automatically adapt since they use the same `_strip_fenced` pipeline as `parse_tasks`.
- **All four helper functions** use the convention of echoing an error message and returning non-zero on failure, echoing empty and returning zero on success. `validate_task_list` follows the same convention.
- **Older plans without the HTML comment** do not break — the count cross-check is skipped with a warning. The sequential and duplicate checks still provide value.
