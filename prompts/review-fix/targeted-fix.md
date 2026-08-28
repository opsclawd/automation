You are fixing code review findings identified during the authoritative whole-change review.

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

Review findings to fix:
```
{{var:review_findings}}
```

## TASK

Read the review findings and failed acceptance criteria carefully.
Implement the necessary fixes in the repository worktree to resolve all blocking defects.

1. **Targeted Scope**:
   - Fix ONLY what the review findings report. Do not expand scope or refactor unrelated code.
   - Respect repository architectural boundaries (inward dependencies only; do not import `@ai-sdlc/infrastructure` in `packages/application`).

2. **Stage and Commit**:
   Stage the modified source files explicitly and commit:
   ```bash
   git add <files>
   git commit -m "fix: address whole-change review findings"
   ```
   Confirm the working tree is clean and HEAD has advanced.

## FINAL ACTION

Write `./result.json` with:
```json
{
  "result": "done_with_fixes"
}
```

## CRITICAL RULES

- Do NOT ask questions.
- Do NOT switch git branches.
- Commit all changes before writing `./result.json`.
- Write `./result.json` before stopping.
