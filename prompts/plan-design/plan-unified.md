You are planning the implementation of this GitHub issue.

## CONTEXT

{{var:WORKSPACE_CONSTRAINTS}}

Working directory: {{var:cwd}}
Issue number: {{var:issue_number}}

Issue description:
{{artifact?:issue.md}}

Issue comments:
{{artifact?:issue-comments.md}}

## TASK

Use the issue and comments provided above as the authoritative requirements.

Also read:
- `AGENTS.md`
- `CONTEXT.md`
- relevant ADRs and design documentation
- the existing implementation and tests in the affected area

Investigate the repository and produce a concrete implementation plan grounded in the current codebase.

Treat the issue's Anchored Design, Non-goals, and Acceptance Criteria as authoritative. If the current code reveals important constraints or conflicts with the proposed design, explain them rather than silently ignoring them.

Make reasonable engineering decisions. Do not try to predict or restrict every file the implementation may need to touch.

Return:
- `design_md`: the important design decisions, rationale, assumptions, and risks
- `plan_md`: the implementation approach, important changes, testing strategy, and validation approach

## OUTPUT FORMAT

Write your structured planning package to `./result.json`:

```json
{
  "design_md": "# Design document markdown...",
  "plan_md": "# Implementation plan markdown..."
}
```

## CRITICAL RULES

- Do not modify source files or implement the issue.
- Do not switch git branches.
- Do not ask questions; state assumptions explicitly in the design document.
- Write `./result.json` before stopping.
