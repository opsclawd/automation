# Learnings from this run

## CONTEXT
Plan: {{artifact:plan.md}}
Design: {{artifact:design.md}}

## TASK
Review the implementation and capture learnings.
Your working directory is: {{var:cwd}}
Write your findings to `{{var:cwd}}/compound.md`.

Output format:
- `{{var:cwd}}/compound.md`: A markdown document explaining what worked, what didn't, and what to do differently next time.
- `result.json`: exactly this shape (fill in `summary` with one sentence describing the document):
  ```json
  { "result": "written", "path": "{{var:cwd}}/compound.md", "summary": "<one-sentence summary>" }
  ```

## CRITICAL RULES
- Do NOT ask questions.
- Do NOT switch branches.
- Write `compound.md` first, then `result.json`.
