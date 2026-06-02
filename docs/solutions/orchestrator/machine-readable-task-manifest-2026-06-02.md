---
title: Machine-readable task manifest — replacing prose scraping with structured JSON
date: 2026-06-02
category: orchestrator
module: scripts/lib/parse_tasks_helpers.sh
problem_type: structural-fix
component: task-parsing
symptoms:
  - Orchestrator parses phantom tasks from example headers or fenced fixtures
  - The safety-validation from #178 catches the mismatch but the parsing approach itself is fragile
  - Plan-write (LLM) has to be careful about how it writes example task headers
root_cause: implicit_contract
resolution_type: pattern
severity: high
related_components:
  - scripts/ai-run-issue-v2
  - scripts/lib/parse_tasks_helpers.sh
  - scripts/lib/__tests__/parse_tasks.bats
tags:
  - bash
  - jq
  - task-manifest
  - task-parsing
  - plan
---

# Machine-Readable Task Manifest — Replacing Prose Scraping with Structured JSON

## Problem

The orchestrator determines the task list by scraping `^#{2,3} Task N:` headers out of freeform Markdown prose in `plan.md` via `parse_tasks()` (`scripts/lib/parse_tasks_helpers.sh:291`). This implicit contract between plan-write (LLM) and the orchestrator (script) has broken twice:

- **#168**: Example headers in validation sections counted as real tasks (11 parsed instead of 5).
- **#172**: 39 fenced code fixtures containing `Task N:` patterns counted as real tasks (49 parsed instead of 10).

The fence-aware parser (`_strip_fenced`) and `validate_task_list()` from #176/#178 were stopgaps that added heuristics on top of an already fragile approach. The task list is the deterministic backbone of the entire run — `find_first_incomplete_task`, `implement-task-N.result` checkpoints, resume logic, and the arbiter all index by task number. Scraping it from freeform prose makes that backbone hostage to plan formatting.

## Solution

Replace prose-scraping with a **structured JSON manifest** (`task-manifest.json`) as the machine-readable source of truth, emitted by plan-write alongside the human-readable `plan.md`.

### Manifest Schema

The manifest lives at `task-manifest.json` co-located with `plan.md`:

```json
{
  "version": 1,
  "task_count": 3,
  "tasks": [
    {
      "n": 1,
      "title": "Add read_manifest function",
      "files": ["scripts/lib/parse_tasks_helpers.sh"],
      "validation": ["pnpm test:bash"]
    }
  ]
}
```

Fields: `version` (always 1), `task_count` (must equal `tasks.length`), `tasks[]` with `n` (sequential, 1-indexed), `title` (required, non-empty), `files` (optional), `validation` (optional).

### Architecture

Plan-write emits **both** `plan.md` and `task-manifest.json` in a single LLM response. The orchestrator reads the manifest as source of truth for task boundaries. `plan.md` remains for human/agent readability — `extract_task_text` and `extract_task_commit_msg` still read prose from it, but `parse_tasks`, `find_first_incomplete_task`, `detect_resume_point`, `validate_task_list`, and PR body generation all read from the manifest when present.

### Key Functions

| Function | File:Line | Role |
|---|---|---|
| `read_manifest()` | `parse_tasks_helpers.sh:13` | Validates manifest via `jq -e`, populates `MANIFEST_TASKS` and `MANIFEST_COUNT` |
| `parse_tasks()` | `parse_tasks_helpers.sh:291` | Checks for manifest first; falls back to fence-aware scraping |
| `find_first_incomplete_task()` | `parse_tasks_helpers.sh:219` | Uses manifest count for loop bound when available |
| `detect_resume_point()` | `parse_tasks_helpers.sh:255` | Uses manifest count for all-complete detection |
| `validate_task_list()` | `parse_tasks_helpers.sh:141` | Validates against manifest when present; falls back to prose heuristics |
| PR body generation | `ai-run-issue-v2:3126` | Reads task titles from manifest, falls back to scraped `plan.md` |
| Plan-write prompt | `ai-run-issue-v2:1107` | Updated to instruct LLM to emit both files |

### Backward Compatibility / Fallback

Every function that reads the manifest checks for its existence and validity first, falling back to the existing fence-aware scraping path if absent or invalid. This means:

- **Old plans without a manifest** work identically to before.
- **Invalid manifests** (bad JSON, wrong version, count mismatch) produce a warning and fall back.
- **Missing manifests** produce a warning and fall back.
- The fallback path exercises the same `_strip_fenced` / regex scraping pipeline from #176/#178.

## Key Implementation Decisions

### 1. Single `jq -e` validation instead of a shell loop

The initial implementation validated the manifest using a Bash for-loop that spawned 2×N `jq` processes and used arithmetic comparison (`$((i+1))`). Review feedback (Finding 4) replaced this with a single `jq -e` validation expression that checks version, task_count, sequential n values, and non-empty titles in one pass:

```bash
if ! jq -e '
  .version == 1 and
  .task_count == (.tasks | length) and
  (.tasks | type == "array") and
  ([ .tasks[].n ] == [ range(1; (.task_count + 1)) ]) and
  ([ .tasks[].title | type == "string" and length > 0 ] | all)
' "$manifest_path" >/dev/null 2>&1; then
```

This avoids the arithmetic syntax risk from non-integer `n` values and reduces process spawning from 2N+1 to exactly 2 (`jq -e` for validation, `jq -r` for extraction).

### 2. Separate file over embedded JSON block

Approach C (hybrid: standalone `task-manifest.json` + `plan.md`) was chosen over Approach B (fenced JSON block inside `plan.md`). Reasoning:
- Strongest separation of concerns — the orchestrator never touches prose for task boundaries
- `jq` read/validate is trivial on a standalone file
- The existing `TASK_MANIFEST` variable at line 1245 and cleanup pattern at line 3254 in `ai-run-issue-v2` confirmed this was always the intended direction
- The sync risk (two files diverging) is mitigated because the LLM generates both in a single response — the prose is derived from the manifest, not vice versa

### 3. `read_manifest` stderr propagation

Initial implementation used `2>/dev/null` at all production call sites to suppress validation errors. Review feedback (Finding 6) removed `2>/dev/null` from all production callers so validation errors propagate to the orchestrator's stderr log. Only the bats test file retains `2>/dev/null` for failure-case tests.

### 4. `detect_resume_point` early return for all-complete case

The initial implementation nested the all-complete check inside a `case "complete")` branch after calling `get_task_completion_status("$first_incomplete")`. When all tasks are complete, `first_incomplete = task_count + 1`, and calling `get_task_completion_status` on a non-existent task returns `"pending"`, which incorrectly routes to `"implement"`. The fix (Finding 5) moves the task_count lookup and the `first_incomplete > task_count` check **before** `get_task_completion_status`, with an early return of `"validate"`.

### 5. Manifest replaces `<!-- task-count: N -->` HTML comment

The `<!-- task-count: N -->` convention from #178 is no longer required when a manifest exists — `task_count` in the manifest serves the same purpose. The plan-write prompt was updated to state this explicitly. Old plans still work via the HTML comment fallback path.

### 6. Archive pre-seeding must include manifest

Resume from archive (`read_issue` phase with an archived run) copies `plan.md` and `design.md` from the archive. Finding 2 added `cp "${ARCHIVE_DIR}/task-manifest.json" "${WORKTREE_DIR}/task-manifest.json"` to this pre-seeding block, or the resume would lose the manifest and fall back to scraped parsing.

### 7. `task-manifest.json` excluded from contract-violation checks

Plan-write's contract-violation detection (`git diff --name-only` filtered with `grep -vE`) was initially triggered by the new manifest file since it looked like an unexpected source code change. Finding 1 added `task-manifest.json` to the exclusion patterns for both the main checkout and worktree git diffs:

```bash
grep -vE '^(plan\.md|design\.md|\.gitignore|task-manifest\.json)$'
```

### 8. `task-manifest.json` added to gitignore exclusion list

The `seed_excludes()` function that writes initial `.gitignore` rules was missing `task-manifest.json` (Finding 3). Added to the exclude patterns so the manifest is treated as an artifact (like `plan.md` and `design.md`), not tracked in version control.

## Gotchas and Pitfalls

### PR_TASKS formatting needs NF guard

When `read_manifest` succeeds but `MANIFEST_TASKS` has empty lines (from `jq -r '.tasks[].title'` with edge-case content), `awk '{print "- " $0}'` produces malformed `"- "` bullets. Fixed (Finding 7) with `awk 'NF {print "- " $0}'`.

### The plan-write prompt is also in ai-run-issue-v2

Two parts of the prompt were updated: the manifest schema section and the critical-rules section. Both must stay in sync — the schema example and the rule that `<!-- task-count: N -->` is no longer required.

### Tests must stub `emit_event` and export `ISSUES_DIR`

- `validate_task_list` calls `emit_event`. In bats, stub with `emit_event() { true; }`.
- `find_first_incomplete_task` and `detect_resume_point` read `$ISSUES_DIR`. The bats `setup()` function must export `ISSUES_DIR="$TMPDIR_TEST"`.

### `jq -e` exit codes are subtle

`jq -e` exits 0 when the last output is truthy (non-null, non-empty, non-false), 1 when falsy, and 4 when there's an error. The `!` negation in `if ! jq -e ...` only catches exit code 1 (falsy validation), not exit code 4 (error). The initial `jq -e '.' "$manifest_path"` call handles the "not valid JSON" case (exit code 4), so the main validation call only needs to distinguish valid vs invalid, not parse errors. This is why the two calls are separate — the first catches JSON parse errors, the second validates the schema.

## What to Know When Modifying

- **`read_manifest()`** (`parse_tasks_helpers.sh:13`): The single `jq -e` expression is the validation gate. Add new schema fields by extending the `jq` filter. The two global variables (`MANIFEST_TASKS`, `MANIFEST_COUNT`) carry data out of the function — any new caller must reset them before calling.
- **Adding a new manifest consumer**: Follow the pattern: reset globals, check file exists, call `read_manifest`, use globals on success, fall back on failure. Do NOT suppress stderr in production callers.
- **Adding a new manifest field**: Update the schema in `PLAN_WRITE_PROMPT` (`ai-run-issue-v2:1107`), the `jq` extraction in `read_manifest()`, and the test fixtures.
- **The fallback path will be removed eventually**: The old scraper (`_strip_fenced` pipeline) and validation helpers (`_extract_declared_count`, `_check_fixture_titles`) remain for backward compatibility but should be removed in a separate cleanup issue once all active runs use manifests.
- **`extract_task_text` still reads prose**: It finds `## Task N:` headers in `plan.md` to extract per-task body text. If the LLM omits a header, text extraction fails. This is pre-existing behavior — a future enhancement could store task body line ranges in the manifest.
- **Manifest version field**: Currently `version: 1`. Schema evolution should bump this and add a migration path in `read_manifest()`. Unknown versions are rejected.
- **Verification commands**:

```bash
pnpm test:bash                          # all bats tests (256+ tests)
bats scripts/lib/__tests__/parse_tasks.bats  # manifest-specific + scraping tests
bash -n scripts/lib/parse_tasks_helpers.sh    # syntax check
bash -n scripts/ai-run-issue-v2               # syntax check
pnpm depcruise                          # layer + circular-dep check
pnpm -r typecheck                       # catch missing deps
pnpm lint                               # lint
```

### File Locations

| Path | Role |
|---|---|
| `scripts/lib/parse_tasks_helpers.sh:13-43` | `read_manifest()` — core manifest validation + extraction |
| `scripts/lib/parse_tasks_helpers.sh:141-217` | `validate_task_list()` — manifest-aware validation |
| `scripts/lib/parse_tasks_helpers.sh:219-253` | `find_first_incomplete_task()` — manifest-aware counting |
| `scripts/lib/parse_tasks_helpers.sh:255-289` | `detect_resume_point()` — manifest-aware resume |
| `scripts/lib/parse_tasks_helpers.sh:291-307` | `parse_tasks()` — manifest-first parsing |
| `scripts/ai-run-issue-v2:~1007` | Archive pre-seeding (manifest copy) |
| `scripts/ai-run-issue-v2:~1107-1175` | Updated `PLAN_WRITE_PROMPT` |
| `scripts/ai-run-issue-v2:~1210-1223` | Contract-violation exclusion patterns |
| `scripts/ai-run-issue-v2:~1240-1254` | Post-plan-write manifest presence check |
| `scripts/ai-run-issue-v2:~3126-3143` | PR body generation from manifest |
| `scripts/lib/__tests__/parse_tasks.bats` | 17 manifest-specific test cases |
