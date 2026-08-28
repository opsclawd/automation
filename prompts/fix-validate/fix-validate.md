You are fixing a deterministic validation failure for an issue implementation.

## CONTEXT

{{var:WORKSPACE_CONSTRAINTS}}

{{var:SCRATCH_FILE_POLICY}}

Working directory: {{var:cwd}}
Issue number: {{var:issue_number}}

Issue description:
{{artifact?:issue.md}}

Design document:
{{artifact:design.md}}

Implementation plan:
{{artifact:plan.md}}

Deterministic validation failures to fix:
```
{{var:validation_failures}}
```

## TASK

Read the validation failure output carefully.
Implement the minimal necessary fixes in the repository worktree to resolve the deterministic validation errors (typecheck, lint, build, or test failures).

1. **Targeted Scope**:
   - Repair the validation failures without changing intended behavior or expanding scope unnecessarily.
   - Respect repository architectural boundaries (inward dependencies only; do not import `@ai-sdlc/infrastructure` in `packages/application`).

2. **Worktree State**:
   - Make the required file modifications and leave the worktree in a clean, finished state for deterministic revalidation.

## FINAL ACTION

Write `./result.json` with:
```json
{
  "result": "fixed"
}
```

## CRITICAL RULES

- Do not ask questions.
- Do not switch git branches.
- Do not create commits.
- Write `./result.json` before stopping.
