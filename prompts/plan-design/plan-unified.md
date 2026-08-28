You are analyzing a GitHub issue to produce a complete, unified planning package (design document and implementation plan).

## CONTEXT

{{var:WORKSPACE_CONSTRAINTS}}

You are working in the repository worktree.
Issue file: issue.md (contains the GitHub issue description, goal, verified evidence, anchored design, non-goals, and acceptance criteria)
Comments file: issue-comments.md (contains issue comments, may not exist)

## TASK

1. Read `issue.md` and `issue-comments.md` (if it exists) thoroughly.
2. Analyze the codebase to understand existing patterns, types, layer boundaries, and architecture relevant to this issue.
3. Formulate the design and implementation plan:
   - **design_md**: Markdown content covering:
     - Problem being solved and why it matters
     - Key design decisions and trade-offs considered
     - Proposed approach with rationale
     - Assumptions made (do not ask questions — state assumptions explicitly)
     - What is in scope and what is explicitly out of scope
     - Risks or concerns identified from code analysis
     - Tooling and testing conventions: state which existing repository conventions are followed.
   - **plan_md**: Markdown implementation plan covering:
     - Goal and non-goals
     - Affected files (full paths from repo root)
     - Ordered implementation tasks — each task MUST be an H2 heading starting at column 0, e.g. `## Task 1: Title` (never H3 `###` or deeper). Task numbers are always sequential integers (1..N).
     - Behavioral invariants: state-machine, loop, or stateful tasks MUST enumerate their behavioral invariants.
     - Tests to add or update
     - Scoped validation commands (exact commands to verify correctness for each task)
     - Risk areas and stop conditions
     - HARD RULE — PORT/INTERFACE CHANGES: When a task adds new methods to a port/interface, ALL adapter/implementation changes for those methods MUST be in the same task.
     - HARD RULE — TEST-FIRST COMMIT ORDER: When the issue describes a defect in behavior that already exists and is wrong today, the test reproducing it must be an earlier numbered RED task prefixed with `! ` in its validation command. For additive feature work / new capabilities, tests belong in the same task as the implementation.

## OUTPUT FORMAT

Return your structured response in `result.json` with the following schema:

```json
{
  "design_md": "# Design document markdown string...",
  "plan_md": "# Implementation plan markdown string..."
}
```

## CRITICAL RULES

- The application is the sole writer of canonical planning artifacts (`design.md`, `plan.md`). Do NOT write these files directly to the worktree filesystem.
- Do NOT ask questions. Make reasonable assumptions and document them explicitly.
- Do NOT switch branches (no `git checkout`, `git switch`, `git stash branch`).
- Stop after returning the planning package. Do not modify source code or implement anything.
