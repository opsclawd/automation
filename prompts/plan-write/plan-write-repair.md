You are repairing a previously-written implementation plan that failed structural validation.

## CONTEXT

{{var:WORKSPACE_CONSTRAINTS}}

Your previous attempt at the implementation plan / task manifest failed structural validation with this
specific error:

{{var:validation_error}}

The existing draft artifacts are provided below for reference — read them carefully before making changes.

Design doc: {{artifact:design.md}}
Issue file: {{artifact:issue.md}}
Current plan: {{artifact:plan.md}}
Current task manifest: {{artifact:task-manifest.json}}

## TASK

Make the **minimal fix** required to resolve the reported error above, while preserving everything
else in the plan prose and task manifest that is already correct. Do not regenerate the plan from
scratch. For example:

- If the error names a duplicate task title, rename the second (or later) occurrence to
  disambiguate it — keep both tasks, just give them distinct titles in both the `plan_md` prose and
  `task_manifest`.
- If the error says manifest tasks are missing from the `plan_md` prose (or prose tasks are missing
  from the manifest), add the missing `## Task N: Title` heading(s) to `plan_md`, or add the missing
  entry to `task_manifest.tasks`, so both describe the exact same set of tasks.
- If the error is about non-sequential task numbers, renumber tasks to be contiguous, plain integers
  starting at 1, updating every reference to the renumbered task(s) in both prose and manifest.
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
- Task numbers are always plain integers matching `tasks[].n` in `task_manifest` — NEVER use
  letter suffixes like `## Task 4a` or `## Task 4b`. If a fix requires splitting a task, assign each
  part its own sequential integer instead.
- Task numbers must be contiguous starting at 1 with no gaps or duplicates, in both `plan_md` and
  `task_manifest`.
- `task_manifest` must remain valid per its schema: `version: 2`, `task_count` equal to
  `tasks.length`, each task with a numeric `n` and non-empty string `title`. Preserve any existing
  `permitted_areas`, `may_extend`, `non_goals`, `reference_files`, `signature_changes`, `task_type`, and `paired_with_task` fields — do not remove valid declarations or convert them to V1 format.
- Scope preservation and narrowing: Preserve valid scope declarations. Fix collisions with the narrowest permission instead of widening obligations or repository scope. Never declare or widen permissions to the repository root `""` or `.`.
- When showing example task headers for illustration only (not real task headings), indent them by
  at least 2 spaces or wrap in inline code — a real task heading always starts at column 0.
- TEST-FIRST COMMIT ORDER: Do not merge a regression-proof task into its implementation task. If the
  plan reproduces a bug with a failing test in an earlier numbered task and fixes it in a later one,
  preserve that separation while repairing — renumber them if required, but keep the proof ahead of
  the fix and keep the implementation source change out of the proof task. Do not use runner-level
  inversion helpers (such as Vitest's `it.fails()` or `test.fails()`) in RED tasks targeted by
  `!`-prefixed validation commands. For additive feature work,
  preserve unit tests co-located within the same task as their implementation code.
- MISAPPLIED TEST-FIRST SPLIT ON NEW CAPABILITY: If you find a RED-only task (or a chain of them) whose
  tests assert a new outcome, port, or capability that does not exist anywhere in the current codebase —
  not a defect in something that already exists — this is a misapplication of TEST-FIRST COMMIT ORDER,
  not a plan to preserve. Merge the RED task(s) and their implementation task back into one task per
  natural unit of work, with tests co-located. Do not "fix" this by patching validation commands or
  compiler traps around the split; the split itself is the defect. Mid-plan revalidation runs the full
  workspace test suite with no awareness of `!`-prefixed inversion in `task-manifest.json`, so a
  multi-task gap between a new capability's RED proof and its implementation will be misread as a
  failing build the moment any review-fix iteration fires on the RED task — collapsing the split fixes
  the root cause rather than the symptom.
- DEFERRED SIGNATURE CHANGES IN RED TASKS: When a RED or regression-proof task asserts against a field,
  property, or shape whose signature change lands in a later task, check which compiler trap actually
  applies and fix the right side:
  - Reading a not-yet-existent field off the actual returned/mutated value (`Property does not exist`) —
    cast the value through a local interface or type assertion before reading, e.g.
    `const typed = result as unknown as { newField: string[] }`. Typing only the expected comparison
    value does not fix this.
  - Constructing an expected value or call argument as a fresh literal with fields the current type
    lacks (excess-property check) — route it through an explicitly-typed local variable or interface
    instead of assigning the literal directly into a contextually-typed position.
  RED tasks asserting on output most often need the first guard, not the second.
  - Finalizing a deferred signature: The task that declares a deferred `signature_changes` entry must
    include `may_extend` (not `reference_files`) for any file where an earlier task used a
    local-cast/widened-type workaround anticipating that same signature, so it has permission to replace
    the workaround with direct typed access once the signature is real — an optional touchpoint, not a
    required deliverable.
- SIBLING IMPLEMENTERS AND TEST DOUBLES OF CHANGED SIGNATURES: If a task declares a `signature_changes`
  entry for an interface, port, or type, search the affected packages (e.g. `implements <InterfaceName>`,
  `extends <InterfaceName>`, or direct references to the changed type) for any sibling concrete classes,
  adapters, fakes, mocks, or test doubles that implement or extend that interface/shape. Ensure all such
  files are included in the same task's `expected_files` (not `reference_files`) so they can be updated
  and pass typechecking (`TS2416`).
- TOOLING AND TEST FRAMEWORK CONVENTION GROUNDING: When specifying a test framework, file extension, or
  similar tooling choice for a new file, check sibling/analogous files in the repository and match their
  established convention unless an explicit rationale is stated in the plan. Any intentional deviation
  must be explicitly documented with its reason in the plan prose.

## OUTPUT

Write a single file named `result.json` at the working-directory root with this exact shape:

```json
{
  "result": "ready",
  "plan_md": "<repaired markdown implementation plan>",
  "task_manifest": {
    "version": 2,
    "task_count": N,
    "tasks": [ ... ]
  }
}
```

## CRITICAL RULES

- Do NOT ask questions. Make the fix directly.
- Do NOT write `plan.md` or `task-manifest.json` to the worktree. Return them in the `plan_md` and `task_manifest` fields of `result.json`.
- Do NOT switch branches (no `git checkout`, `git switch`, `git stash branch`).
- Do NOT edit any source files (`*.ts`, `*.js`, `*.sh`, `*.py`, etc.). Your ONLY output is `result.json`.
- Do NOT create standalone "run validation suite" or "make CI green" tasks.
- Stop after writing `result.json`. Do not implement anything.
