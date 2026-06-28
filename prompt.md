You are writing an implementation plan.

## CONTEXT

You are working in the repository worktree.
Design doc: `design.md` (produced in the previous brainstorming step)
Issue file: `issue.md`
Comments file: `issue-comments.md` (may not exist)

## TASK

1. Load the writing-plans skill: say exactly `/skill writing-plans` to activate it.
2. Read `design.md`, `issue.md`, and `issue-comments.md` (if it exists).
3. Using the writing-plans skill guidance, produce a complete implementation plan at `./plan.md`.
4. ALSO write `./task-manifest.json` alongside `plan.md` (see schema below).

The plan MUST include:

- goal
- non-goals
- affected files (full paths from repo root)
- ordered implementation tasks (numbered, clear description per task) — each task MUST be an H2 heading starting at column 0, e.g. `## Task 1: Title` (never H3 `###` or deeper)
- tests to add or update
- validation commands (exact commands to verify correctness)
- risk areas
- stop conditions (what would cause you to abort instead of continue)
- Verification commands must be scoped to the files/paths explicitly changed by each task. Do NOT use whole-file grep/rg on files where the task only changes a subset — scope to specific line ranges or file sections.
- Prefer making verification an acceptance criterion of implementing tasks rather than a standalone "Full verification" task. If a standalone verification task is necessary, its verification commands must reference only files/paths explicitly in scope for that task.
- HARD RULE: DO NOT create standalone tasks whose purpose is "run the validation suite", "make CI green", "fix failing tests", "run full validation", or any variant thereof. Validation runs automatically after ALL implement tasks complete (dedicated validate phase). If a test file needs updating, that is its own implementation task with the test file explicitly in scope — NOT a validation task.
- PARITY COVERAGE: If a task modifies a _watched legacy path_ — `scripts/ai-run-issue-v2`, `scripts/ai-pr-review-poll`, anything under `scripts/lib/` (except `__tests__/`), `apps/cli/src/run-agent.ts`, `apps/cli/src/run-pr-poll.ts`, or anything under `packages/infrastructure/src/agent/` (matching is recursive: any file at or below those prefixes) — that SAME task MUST also add or extend a parity[#<issue>] characterization test in `scripts/lib/__tests__/legacy-parity.bats` pinning the behavioral invariant the change establishes. List `scripts/lib/__tests__/legacy-parity.bats` in that task's files, and describe the invariant to pin (what runtime behavior must survive the TypeScript cutover — see issue #210). EXCEPTION: a purely non-behavioral edit (comments, log/wording, formatting) has no invariant to pin — do NOT add a tautological test.
- SPLIT OVERSIZED TEST-UPDATE TASKS: If a task's primary purpose is updating an existing test file (modifying tests in a `*.test.ts`, `*.test.tsx`, `*.spec.ts`, or `*.bats` file), and that test file exceeds ~500 lines or ~10 test cases (`describe`/`it`/`test` blocks), you MUST split the task into multiple smaller tasks. Each split task should target a subset of describe-blocks or test cases. Each split task must be independently committable (one commit, all tests pass for that subset). Non-test tasks (implementation code, configuration, new files) are unaffected by this heuristic.

## TASK MANIFEST SCHEMA

Write `task-manifest.json` as a JSON file with this exact structure:

```json
{
  "version": 1,
  "task_count": N,
  "tasks": [
    {
      "n": 1,
      "title": "Short task title",
      "files": ["path/to/file1", "path/to/file2"],
      "validation": ["command to verify"]
    }
  ]
}
```

Fields:

- `version`: always `1`
- `task_count`: must equal `tasks.length`
- `tasks[].n`: sequential 1-indexed task number
- `tasks[].title`: one-line summary matching the prose task header
- `tasks[].files`: files the task touches (optional but encouraged)
- `tasks[].validation`: commands to verify task completion (optional but encouraged)

The manifest is the machine-readable source of truth for task boundaries. `plan.md` remains the human-readable document with full prose.

## PLAN RISK CLASSIFICATION

After writing `plan.md`, check whether your plan contains any of these patterns:

- A retry loop or recovery path
- A state machine with explicit transitions
- An irreversible side effect (e.g., posting to an external API, writing to a database)

If ANY of these patterns exist, add this HTML comment to the VERY FIRST LINE of `plan.md`:

```
<!-- plan-review-required -->
```

If none exist, do NOT add the comment. Simple/mechanical plans (adapters, CRUD, schema changes) should skip review.

## CRITICAL RULES

- Do NOT ask questions. Make reasonable assumptions and document them.
- Do NOT rely on agent memory. Write everything to `plan.md`.
- Do NOT switch branches (no `git checkout`, `git switch`, `git stash branch`).
- Stop after writing `plan.md` AND `task-manifest.json`. Do not implement anything.
- All shell commands in the plan MUST be relative — no absolute paths, no `cd` to directories outside the worktree.
- Do NOT edit any source files (`*.ts`, `*.js`, `*.sh`, `*.py`, etc.). Your ONLY output is `plan.md` and `task-manifest.json`.
- When a plan needs to show example task headers (e.g., in validation instructions or test fixtures), indent them by at least 2 spaces or wrap in inline code. Real task headings start at column 0; anything indented is treated as an example. Violating this rule causes task extraction to misread the plan.
- Do NOT create standalone "run validation suite" or "make CI green" tasks.
- Write `plan.md` first, then `task-manifest.json`.
