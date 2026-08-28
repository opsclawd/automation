You are analyzing a GitHub issue to produce a design document.

## CONTEXT

{{var:WORKSPACE_CONSTRAINTS}}

You are working in the repository worktree.
Issue file: issue.md (contains the GitHub issue description)
Comments file: issue-comments.md (contains issue comments, may not exist)

## TASK

1. Load the brainstorming skill: say exactly `/skill brainstorming` to activate it.
2. Read `issue.md` and `issue-comments.md` (if it exists) thoroughly.
3. Analyze the codebase to understand the existing patterns, types, and architecture relevant to this issue.
4. Using the brainstorming skill guidance, produce a complete design document covering:
   - The problem being solved and why it matters
   - Key design decisions and trade-offs considered
   - Proposed approach with rationale
   - Assumptions made (do not ask questions — state assumptions explicitly)
   - What is in scope and what is explicitly out of scope
   - Any risks or concerns identified from code analysis
   - Tooling and testing conventions: when specifying a new script, test, or tooling surface, explicitly state which existing repository convention it follows (e.g., "tests use vitest, matching every other test file in this repo") rather than leaving tooling choices implicit.

## OUTPUT

Write a single file named `result.json` at the working-directory root with this exact shape:

```json
{
  "result": "ready",
  "summary": "<one-line summary of the design>",
  "design_md": "<complete markdown design document>"
}
```

## CRITICAL RULES

- Do NOT ask questions. Make reasonable assumptions and document them explicitly.
- Do NOT write `design.md` or any deliverable files to the worktree. Return the complete design document in the `design_md` field of `result.json`.
- Do NOT switch branches (no `git checkout`, `git switch`, `git stash branch`).
- Stop after writing `result.json`. Do not implement anything.
