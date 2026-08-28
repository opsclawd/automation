You are writing an implementation plan.

## CONTEXT

{{var:WORKSPACE_CONSTRAINTS}}

You are working in the repository worktree.
Design doc: `design.md` (produced in the previous brainstorming step)
Issue file: `issue.md`
Comments file: `issue-comments.md` (may not exist)

## TASK

1. Load the writing-plans skill: say exactly `/skill writing-plans` to activate it.
2. Read `design.md`, `issue.md`, and `issue-comments.md` (if it exists).
3. Using the writing-plans skill guidance, produce a complete implementation plan and task manifest.
4. Format your output as a JSON object in `result.json` containing `plan_md` and `task_manifest` (see schema below).

The plan MUST include:

- goal
- non-goals
- affected files (full paths from repo root)
- ordered implementation tasks (numbered, clear description per task) — each task MUST be an H2 heading starting at column 0, e.g. `## Task 1: Title` (never H3 `###` or deeper). Task numbers are always plain integers matching `tasks[].n` — NEVER use letter suffixes like `## Task 4a` or `## Task 4b`. If splitting a task, assign each part its own sequential integer (e.g., Task 4 and Task 5).
- behavioral invariants: state-machine, loop, or stateful tasks MUST enumerate their behavioral invariants (e.g., "when input is X and state is Y, transition to Z"). These become named test cases the implementer writes FIRST.
- tests to add or update
- validation commands (exact commands to verify correctness)
- risk areas
- stop conditions (what would cause you to abort instead of continue)
- Verification commands must be scoped to the files/paths explicitly changed by each task. Do NOT use whole-file grep/rg on files where the task only changes a subset — scope to specific line ranges or file sections.
- HARD RULE — PORT/INTERFACE CHANGES: When a task adds new methods to a port/interface, ALL adapter/implementation changes for those methods MUST be in the same task. Never split the port change from its adapter updates across separate tasks. After every implementation step the implement loop runs `pnpm -r typecheck` workspace-wide as an automatic gate — a port-only step will always fail this gate because downstream adapters haven't been updated yet, and no change to the task's validation command can bypass it. If the combined port + adapters task is too large, split by method (one new method per task, port + all its adapters together) — never split by layer.
- Prefer making verification an acceptance criterion of implementing tasks rather than a standalone "Full verification" task. If a standalone verification task is necessary, its verification commands must reference only files/paths explicitly in scope for that task.
- HARD RULE: DO NOT create standalone tasks whose purpose is "run the validation suite", "make CI green", "fix failing tests", "run full validation", or any variant thereof. Validation runs automatically after ALL implement tasks complete (dedicated validate phase). If a test file needs updating, that is its own implementation task with the test file explicitly in scope — NOT a validation task.
- HARD RULE — TEST-FIRST COMMIT ORDER: When the issue describes a bug, regression, or other incorrect existing behavior, the test that reproduces it MUST be its own **earlier numbered task**, landing before the task that fixes it. That regression-proof task **must not include the implementation source change** — it contains only the failing test, which is expected to fail until the **later implementation task** lands. For regression-proof tasks, prefix the validation command with `! ` (e.g. `! pnpm test -- path/to/test.ts`) so step validation expects the failure. Do NOT use test-runner-level inversion primitives (such as Vitest's `it.fails()` or `test.fails()`) in RED tasks targeted by `!`-prefixed validation commands — runner-level inversion causes the test runner to report exit code 0 when the test fails, which conflicts with the command-level `!` wrapper and breaks step validation. Write tests as standard direct assertions of expected behavior. Keeping the proof in a separate, earlier commit means that if the fix is later removed or reverted, the test fails loudly instead of disappearing in step with the code it was proving. Do NOT collapse these into a single task.
- HARD RULE — THIS RULE DOES NOT APPLY TO NEW CAPABILITY WORK: The test-first split above is for reproducing a defect in **behavior that already exists and is wrong today**. It is not a TDD style preference and must not be used for additive feature work, schema extensions, new outcome variants, new ports, or any capability that does not exist yet. **The test to ask: does the issue describe something the codebase currently does incorrectly? If not — if you are adding something new — this rule does not apply**, no matter how much writing the test first feels like good discipline. For all such work, tests MUST be delivered in the **same task** as the implementation they test, so the workspace is never left red between tasks.
  - Why this matters beyond style: nothing about how a task's own `! `-prefixed validation command works is understood by the orchestrator's broader validation loop. Mid-implement revalidation (triggered by review-fix iterations within a single step) re-runs the full workspace test suite from `.ai-orchestrator.json`, with **no knowledge of `task-manifest.json` or which tests are declared inverted**. It will report a still-red RED-first test as a failing build on every iteration it runs, for as long as the fix task hasn't landed. If a RED-only task happens to trigger even one review-fix iteration for an unrelated reason, this creates real, compounding pressure toward a specific failure mode: an implementer "resolving" the false failure by implementing the deferred behavior early, silently, inside the task that was supposed to only prove it was missing — which is exactly the ordering guarantee this whole rule exists to protect. A one-task gap between RED and its fix mostly survives this by luck (first-attempt code usually clears review without triggering revalidation). A multi-task gap does not: more intervening tasks means more chances for revalidation to fire while the workspace is still correctly, deliberately red — misclassifying a working plan as broken.
  - Concretely: "I'm adding a `recoverable_scope_violation` outcome that doesn't exist yet" is new capability, even though proving the current code can't produce it "fails" like a regression test would. "The classifier picks the wrong task on duplicate declarations" is an existing defect — that one gets the split.
- HARD RULE — DEFERRED SIGNATURE CHANGES IN RED TASKS: When a RED or regression-proof task asserts against a field, property, or shape whose `signature_changes` entry is declared on a later-numbered task, the compiler trap can come from either direction and needs a different guard for each:
  - **Reading a not-yet-existent field off the actual value returned/mutated by the current code** (`TS2339: Property does not exist`) — cast the value through a locally-declared interface or type assertion describing the prospective shape before reading the field, e.g. `const typed = result as unknown as { newField: string[] }; expect(typed.newField).toEqual([...])`. Do not assume typing only the *expected* comparison value fixes this — it does not; the read happens on the actual value's current, narrower type.
  - **Constructing an expected value or call argument as a fresh object literal with fields the current type doesn't have** (excess-property check) — route it through an explicitly-typed local variable or interface rather than assigning the literal directly into a contextually-typed position, e.g. `const expected: SomeWidenedType = { ...currentFields, newField: [...] }`.
  A RED task frequently needs the first guard (asserting on output), not the second — check which one actually applies before writing the task; using only the literal-construction guard when the trap is a property-read will not compile.
  - **Finalizing a deferred signature**: The task that declares a deferred `signature_changes` entry must include `may_extend` (not `reference_files`) for any file where an earlier task used a local-cast/widened-type workaround anticipating that same signature, so it has permission to replace the workaround with direct typed access once the signature is real — this is an optional touchpoint, not a required deliverable, so `expected_files` would wrongly force the cleanup rather than just permit it.
- HARD RULE — SIBLING IMPLEMENTERS AND TEST DOUBLES OF CHANGED SIGNATURES: When a task declares a `signature_changes` entry for an interface, port, or type, listing only the file where the interface itself is declared is not sufficient. The planner MUST perform an explicit search (e.g. searching for `implements <InterfaceName>`, `extends <InterfaceName>`, or direct references to the changed type in affected packages) to identify every concrete class, adapter, fake, mock, or test double that directly implements, extends, or structurally depends on that exact shape. All such files MUST be listed in the same task's `expected_files` (not `reference_files`), as TypeScript will fail typechecking (e.g. `TS2416`) once the interface signature changes if those sibling implementers are omitted.
- HARD RULE — TOOLING AND TEST FRAMEWORK CONVENTION GROUNDING: Before specifying a test framework, file extension, or similar tooling choice for a new file, the planner MUST check sibling or analogous files in the repository (in the same directory or the nearest analogous component elsewhere) and match their established convention unless there is an explicit, stated reason to deviate. Any intentional deviation from existing repository conventions MUST be explicitly documented in the plan along with its rationale — never leave tooling choices as unexplained implementation details.
- SPLIT OVERSIZED TEST-UPDATE TASKS: If a task's primary purpose is updating an existing test file (modifying tests in a `*.test.ts`, `*.test.tsx`, `*.spec.ts`, or `*.bats` file), and that test file exceeds ~500 lines or ~10 test cases (`describe`/`it`/`test` blocks), you MUST split the task into multiple smaller tasks. Each split task should target a subset of describe-blocks or test cases. Each split task must be independently committable (one commit, all tests pass for that subset). Non-test tasks (implementation code, configuration, new files) are unaffected by this heuristic.

## TASK MANIFEST SCHEMA

The `task_manifest` field of `result.json` must be a JSON object with this exact structure:

```json
{
  "version": 2,
  "task_count": N,
  "tasks": [
    {
      "n": 1,
      "title": "Short task title",
      "task_type": "standard",
      "paired_with_task": 2,
      "expected_files": ["path/to/file1", "path/to/file2"],
      "permitted_areas": ["path/to/dir"],
      "may_extend": ["path/to/optional-edit.ts"],
      "non_goals": ["path/to/do-not-touch"],
      "reference_files": ["path/to/read-only.ts"],
      "validation_commands": ["command to verify", ["pnpm", "exec", "eslint", "apps/app/app/position/[id].tsx"]],
      "signature_changes": [
        {
          "declaration_file": "path/to/declaration.ts",
          "symbol": "ExportedSymbolName",
          "change": "modified",
          "note": "Why this declaration is listed"
        }
      ],
      "invariants": [
        {
          "name": "invariant name",
          "description": "behavioral description",
          "test_case_name": "exact name of the test case to write"
        }
      ]
    }
  ]
}
```

Fields:

- `version`: always `2`
- `task_count`: must equal `tasks.length`
- `tasks[].n`: sequential 1-indexed task number
- `tasks[].title`: one-line summary matching the prose task header
- `tasks[].task_type`: Execution intent of the task. Must be one of `"standard"`, `"red"`, `"implementation"`, or `"verification"` (optional).
- `tasks[].paired_with_task`: The 1-based index of the paired task (e.g. the implementation task paired with a red task) (optional).
- `tasks[].expected_files`: files the implementer must modify and commit (optional but encouraged). Keep `expected_files` minimal and obligatory: each file listed here is a required deliverable that must appear in the task's committed diff before completion. Root-level expected files (e.g. `package.json` or `README.md`) grant permission only to that exact file and do NOT derive repository-root area permissions.
- `tasks[].permitted_areas`: repository-relative directory roots for bounded incidental tracked edits or for explicitly write-capable empty tasks (optional, default `[]`). Authorizes editing existing tracked files within the specified directory roots; untracked file creations under permitted areas are considered drift and will be rejected. Never declare the repository root `""` or `.` as a permitted area.
- `tasks[].may_extend`: exact repository-relative files for known optional integration touchpoints that may be edited if needed, but are not required deliverables (optional, default `[]`). Cannot duplicate files already listed in `expected_files`.
- `tasks[].non_goals`: exact paths or directory roots that the task must not modify (optional, default `[]`). Excludes the path and any descendants from modifications; overrides permissions. Must not overlap with writable exact paths or permitted areas.
- `tasks[].reference_files`: read-only files the task reads or consults for context, but does not modify or commit (optional, default `[]`). Must remain strictly read-only and cannot overlap with writable declarations (`expected_files`, `may_extend`). Traceability-only declarations marked `change: "not_modified"` belong in `reference_files`. Inspected consumers of `breaking: false` changes that structurally require no update (for example, a pass-through adapter using an imported widened type) also belong in `reference_files` when inspected for blast-radius coverage.
- `tasks[].validation_commands`: commands to verify task completion (optional but encouraged). Entries may be shell command strings (e.g. `"pnpm lint"`) or argv arrays of non-empty strings (e.g. `["pnpm", "exec", "eslint", "apps/app/app/position/[id].tsx"]`) to execute without shell expansion when paths contain brackets or special characters.
- `tasks[].signature_changes`: REQUIRED when the task changes the surface of an exported API (parameter-list, return-type, overload-set, required-generic parameter, or required-member-shape). Each entry names a repository-relative declaration file and the exact symbol being changed. Declaration files MUST be in expected_files (or legacy files), or reference_files (when change is "not_modified"). This field is nullish (optional) when no exported-API signatures change. Each `signature_changes` entry supports the following fields:
  - `declaration_file` (required): repository-relative path to the declaration file
  - `symbol` (required): exact exported symbol name being changed
  - `change` (optional): either `"modified"` (default) or `"not_modified"` — defaults to `"modified"` when omitted for backward compatibility. A symbol listed only because it is referenced for context but deliberately stable MUST set `"change": "not_modified"`; omitting that reference from the manifest and explaining stability in `plan.md` prose also remains valid. `not_modified` entries are retained for traceability but skipped by signature blast-radius enforcement. Declaration files for `"not_modified"` entries may be listed in `reference_files`.
  - `breaking` (optional): a boolean indicating whether the signature change is backward-compatible/additive (`false`) or a breaking structural change (`true`). Defaults to `true` when omitted. Non-breaking signature changes (such as adding an optional field or method) should declare `"breaking": false` to be exempt from mandatory signature blast-radius reference checks.
  - `note` (optional): explanatory text describing why this declaration is listed
  - Unknown fields in a `signature_changes` entry are rejected.
- `tasks[].invariants`: behavioral invariants to be implemented as tests first (REQUIRED for stateful/logic-heavy tasks)

Scope Rules & Planning Guidance:

- Distinguish obligatory deliverables from bounded permissions: Keep `expected_files` minimal and strictly obligatory. Use `may_extend` for known optional integration files and `permitted_areas` for bounded incidental tracked edits.
- Empty tasks require explicit write permissions: A task with no `expected_files` (such as a refactor or test-verification task) is read-only by default. If it needs to make writes, it must explicitly declare `permitted_areas` or `may_extend`.
- Root-level expected files grant exact-only permission: A root file never derives repository-root area permission, and planners must never derive or declare repository-root write access.
- Co-locate additive feature tests: For purely additive feature work with no pre-existing bug to reproduce, co-locate test files with the implementing task rather than creating standalone failing test tasks. (Preserve test-first commit order for bug and regression reproductions).
- No raw directory sweeps: Auto-commit stages only specific classifier-approved paths, never raw directory expansions.

The `task_manifest` value is the machine-readable source of truth for task boundaries. The `plan_md` value contains the complete human-readable document with full prose.

## PLAN RISK CLASSIFICATION

After drafting the implementation plan, check whether your plan contains any of these patterns:

- A retry loop or recovery path
- A state machine with explicit transitions
- An irreversible side effect (e.g., posting to an external API, writing to a database)

If ANY of these patterns exist, prepend this HTML comment to the VERY FIRST LINE of the `plan_md` string:

```
<!-- plan-review-required -->
```

If none exist, do NOT add the comment. Simple/mechanical plans (adapters, CRUD, schema changes) should skip review.

## OUTPUT

Write a single file named `result.json` at the working-directory root with this exact shape:

```json
{
  "result": "ready",
  "plan_md": "<complete markdown implementation plan>",
  "task_manifest": {
    "version": 2,
    "task_count": N,
    "tasks": [ ... ]
  }
}
```

## CRITICAL RULES

- Do NOT ask questions. Make reasonable assumptions and document them.
- Do NOT write `plan.md` or `task-manifest.json` to the worktree. Return them in the `plan_md` and `task_manifest` fields of `result.json`.
- Do NOT switch branches (no `git checkout`, `git switch`, `git stash branch`).
- Stop after writing `result.json`. Do not implement anything.
- All shell commands in the plan MUST be relative — no absolute paths, no `cd` to directories outside the worktree.
- Do NOT edit any source files (`*.ts`, `*.js`, `*.sh`, `*.py`, etc.). Your ONLY output is `result.json`.
- When a plan needs to show example task headers (e.g., in validation instructions or test fixtures), indent them by at least 2 spaces or wrap in inline code. Real task headings start at column 0; anything indented is treated as an example. Violating this rule causes task extraction to misread the plan.
- Do NOT create standalone "run validation suite" or "make CI green" tasks.
- Task numbers in the `plan_md` headings MUST be plain integers (e.g., `## Task 4`) matching `tasks[].n` in the manifest. Letter suffixes (`## Task 4a`) are forbidden and will cause validation to fail.
