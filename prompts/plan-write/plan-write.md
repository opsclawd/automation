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
3. Using the writing-plans skill guidance, produce a complete implementation plan at `./plan.md`.
4. ALSO write `./task-manifest.json` alongside `plan.md` (see schema below).

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
- HARD RULE — TEST-FIRST COMMIT ORDER: When the issue describes a bug, regression, or other incorrect existing behavior, the test that reproduces it MUST be its own **earlier numbered task**, landing before the task that fixes it. That regression-proof task **must not include the implementation source change** — it contains only the failing test, which is expected to fail until the **later implementation task** lands. Keeping the proof in a separate, earlier commit means that if the fix is later removed or reverted, the test fails loudly instead of disappearing in step with the code it was proving. Do NOT collapse these into a single task. This does not apply to purely additive feature work with no pre-existing incorrect behavior to reproduce.
- SPLIT OVERSIZED TEST-UPDATE TASKS: If a task's primary purpose is updating an existing test file (modifying tests in a `*.test.ts`, `*.test.tsx`, `*.spec.ts`, or `*.bats` file), and that test file exceeds ~500 lines or ~10 test cases (`describe`/`it`/`test` blocks), you MUST split the task into multiple smaller tasks. Each split task should target a subset of describe-blocks or test cases. Each split task must be independently committable (one commit, all tests pass for that subset). Non-test tasks (implementation code, configuration, new files) are unaffected by this heuristic.

## TASK MANIFEST SCHEMA

Write `task-manifest.json` as a JSON file with this exact structure:

```json
{
  "version": 2,
  "task_count": N,
  "tasks": [
    {
      "n": 1,
      "title": "Short task title",
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
- Task numbers in `plan.md` headings MUST be plain integers (e.g., `## Task 4`) matching `tasks[].n` in the manifest. Letter suffixes (`## Task 4a`) are forbidden and will cause validation to fail.
- Write `plan.md` first, then `task-manifest.json`.
