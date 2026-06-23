# Implementation Plan for Issue #{{var:issue_number}}

## CONTEXT
Design: {{artifact:design.md}}

## TASK
You are writing the implementation plan for GitHub issue #{{var:issue_number}}, based on the design document above.

Produce a **plan document** (`plan.md`) that contains:
- A numbered list of implementation tasks, each with:
  - A short title
  - The specific files to create or modify (full paths from repo root)
  - Concrete steps to implement the change
  - Validation commands to verify the task is complete
- Tests to add or update
- Risk areas
- Stop conditions (situations that would cause you to abort rather than continue)

Then write `result.json` with this exact shape:
```json
{
  "result": "ready",
  "tasks": [
    { "title": "<task title>", "description": "<optional one-line description>" }
  ]
}
```
Use `"result": "blocked"` if the design is insufficient to produce a plan.

Output format:
- `plan.md`: a Markdown implementation plan
- `result.json`: JSON matching the shape above (one entry per task in the plan)

## CRITICAL RULES
- Do NOT ask questions.
- Do NOT switch branches.
- Write `plan.md` first, then `result.json`.
- Every task in `result.json` must correspond to a task in `plan.md`.
