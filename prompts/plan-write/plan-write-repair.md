You are repairing a previously-written implementation plan that failed structural validation.

## CONTEXT

{{var:WORKSPACE_CONSTRAINTS}}

Your previous attempt at `plan.md` / `task-manifest.json` failed structural validation with this
specific error:

{{var:validation_error}}

The existing files are provided below for reference — read them carefully before making changes.

Design doc: {{artifact:design.md}}
Issue file: {{artifact:issue.md}}
Current plan: {{artifact:plan.md}}
Current task manifest: {{artifact:task-manifest.json}}

## TASK

Make the **minimal fix** required to resolve the reported error above, while preserving everything
else in `plan.md` and `task-manifest.json` that is already correct. Do not regenerate the plan from
scratch. For example:

- If the error names a duplicate task title, rename the second (or later) occurrence to
  disambiguate it — keep both tasks, just give them distinct titles in both `plan.md` and
  `task-manifest.json`.
- If the error says manifest tasks are missing from the `plan.md` prose (or prose tasks are missing
  from the manifest), add the missing `## Task N: Title` heading(s) to `plan.md`, or add the missing
  entry to `task-manifest.json#tasks`, so both files describe the exact same set of tasks.
- If the error is about non-sequential task numbers, renumber tasks to be contiguous, plain integers
  starting at 1, updating every reference to the renumbered task(s) in both files.
- If the error mentions an unbalanced code fence, find and close (or remove) the stray fence.
- If the error reports non-canonical scope paths (e.g., backslashes, leading `./`, duplicate slashes, trailing slashes, or `.`/`..` segments), canonicalize them into trimmed repository-relative paths without altering their intent.
- If the error reports overlapping or contradictory scope declarations:
  - If a file appears in both `reference_files` and writable declarations (`expected_files`, `may_extend`), resolve the collision based on intent: remove from `reference_files` if the file will be edited, or remove from writable declarations if it is read-only.
  - If a file appears in both `may_extend` and `expected_files`, remove it from `may_extend` because `expected_files` is already an obligatory deliverable.
  - If `non_goals` overlaps with writable paths or `permitted_areas`, resolve the contradiction by narrowing the permitted area or adjusting the non-goal boundary.
- If a task needs additional write access, add the **narrowest missing permission** (e.g., add the exact file to `may_extend` or the specific directory to `permitted_areas`). Do NOT inflate `expected_files` obligations or widen permissions to the repository root.

## HARD RULES (carried forward from the original plan-write pass — do not violate them while fixing)

- Every task MUST be an H2 heading starting at column 0, e.g. `## Task 1: Title` (never H3 `###` or
  deeper).
- Task numbers are always plain integers matching `tasks[].n` in `task-manifest.json` — NEVER use
  letter suffixes like `## Task 4a` or `## Task 4b`. If a fix requires splitting a task, assign each
  part its own sequential integer instead.
- Task numbers must be contiguous starting at 1 with no gaps or duplicates, in both `plan.md` and
  `task-manifest.json`.
- `task-manifest.json` must remain valid per its schema: `version: 2`, `task_count` equal to
  `tasks.length`, each task with a numeric `n` and non-empty string `title`. Preserve any existing
  `permitted_areas`, `may_extend`, `non_goals`, `reference_files`, and `signature_changes` fields — do not remove valid declarations or convert them to V1 format.
- Scope preservation and narrowing: Preserve valid scope declarations. Fix collisions with the narrowest permission instead of widening obligations or repository scope. Never declare or widen permissions to the repository root `""` or `.`.
- When showing example task headers for illustration only (not real task headings), indent them by
  at least 2 spaces or wrap in inline code — a real task heading always starts at column 0.
- TEST-FIRST COMMIT ORDER: Do not merge a regression-proof task into its implementation task. If the
  plan reproduces a bug with a failing test in an earlier numbered task and fixes it in a later one,
  preserve that separation while repairing — renumber them if required, but keep the proof ahead of
  the fix and keep the implementation source change out of the proof task. For additive feature work,
  preserve unit tests co-located within the same task as their implementation code.

## CRITICAL RULES

- Do NOT ask questions. Make the fix directly.
- Do NOT switch branches (no `git checkout`, `git switch`, `git stash branch`).
- Do NOT edit any source files (`*.ts`, `*.js`, `*.sh`, `*.py`, etc.). Your ONLY output is `plan.md`
  and `task-manifest.json`.
- Do NOT create standalone "run validation suite" or "make CI green" tasks.
- Write `plan.md` first, then `task-manifest.json`.
