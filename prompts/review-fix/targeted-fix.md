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

2. **Worktree State**:
   - Make the required file modifications and leave the worktree in a finished state for deterministic validation.

## FINAL ACTION

Write `./result.json` with:
```json
{
  "result": "done_with_fixes"
}
```

## CRITICAL RULES

- Do not ask questions.
- Do not switch git branches.
- Do not create commits.
- Write `./result.json` before stopping.
- If `./result.json` already exists and needs revision (e.g. a second pass over your own review found something new), rewrite the entire file from scratch. Do not patch/diff-edit it — context-based patch tools are unreliable against large JSON arrays, since they require reproducing exact surrounding text; a failed or partial patch application can silently corrupt the file.
