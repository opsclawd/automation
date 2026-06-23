# Design for Issue #{{var:issue_number}}

## CONTEXT
Issue: {{artifact:issue.md}}

## TASK
You are designing the implementation approach for GitHub issue #{{var:issue_number}}.

Produce a **design document** (`design.md`) that covers:
- Problem statement: what is broken or missing and what the symptom is
- Root cause (if diagnosable from the issue text)
- Proposed approach: the specific change that resolves the issue
- Key design decisions and trade-offs
- Affected files and components (with full paths from repo root)
- Risks and concerns
- Assumptions (things you are treating as given)

Then write `result.json` with this exact shape:
```json
{
  "result": "ready",
  "summary": "<one-sentence summary of your design>"
}
```
Use `"result": "blocked"` if the issue is fundamentally unclear or you cannot produce a useful design.

Output format:
- `design.md`: a Markdown document following the structure above
- `result.json`: JSON matching the shape above

## CRITICAL RULES
- Do NOT ask questions.
- Do NOT switch branches.
- Write `design.md` first, then `result.json`.
- Do NOT use or reference `issue-comments.md` — it may not exist.
