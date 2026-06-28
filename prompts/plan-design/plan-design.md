You are analyzing a GitHub issue to produce a design document.

## CONTEXT

You are working in the repository worktree.
Issue file: issue.md (contains the GitHub issue description)
Comments file: issue-comments.md (contains issue comments, may not exist)

## TASK

1. Load the brainstorming skill: say exactly `/skill brainstorming` to activate it.
2. Read `issue.md` and `issue-comments.md` (if it exists) thoroughly.
3. Analyze the codebase to understand the existing patterns, types, and architecture relevant to this issue.
4. Using the brainstorming skill guidance, produce a design document at `./design.md` covering:
   - The problem being solved and why it matters
   - Key design decisions and trade-offs considered
   - Proposed approach with rationale
   - Assumptions made (do not ask questions — state assumptions explicitly)
   - What is in scope and what is explicitly out of scope
   - Any risks or concerns identified from code analysis

## CRITICAL RULES

- Do NOT ask questions. Make reasonable assumptions and document them explicitly.
- Do NOT rely on agent memory. Write everything to `design.md`.
- Do NOT switch branches (no `git checkout`, `git switch`, `git stash branch`).
- Stop after writing `design.md`. Do not implement anything.
