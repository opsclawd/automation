# Implement issue

## CONTEXT

{{var:WORKSPACE_CONSTRAINTS}}

You are working in the repository worktree to implement the approved planning package.

Issue description:
{{artifact?:issue.md}}

Issue comments:
{{artifact?:issue-comments.md}}

Design document:
{{artifact:design.md}}

Implementation plan:
{{artifact:plan.md}}

Task manifest:
{{artifact:task-manifest.json}}

## TASK

Execute the implementation plan and all tasks described in `plan.md` and `task-manifest.json` end-to-end.

1. Review the issue requirements, design document, implementation plan, and task manifest.
2. Implement all tasks in the worktree. Write source code and tests adhering to repository standards, type safety, and architectural boundaries.
3. Respect file boundaries:
   - Only modify files declared in `expected_files`, `may_extend`, or `permitted_areas`.
   - Do NOT modify `reference_files` or `non_goals`.
   - Do NOT touch protected configuration files (such as `.gitignore`, `.ai-orchestrator.json`, or `.github/*`) unless explicitly declared in expected_files.
4. Stage new and modified implementation files explicitly and commit them cleanly:
   ```bash
   git add <files>
   git commit -m "type: concise commit subject"
   ```
   Do not use `git add -A` (orchestrator artifacts must remain untracked).

## FINAL ACTION — Unconditional file write

Before you finish, you MUST write exactly one file named `implementation-log.md`
at the worktree root (`./implementation-log.md`).

The file MUST begin with:

    Status: DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT

followed by 1-3 lines describing what changed and a `Files changed:` section listing
all paths touched in this run.

## CRITICAL RULES

- Do NOT ask questions. Make reasonable technical assumptions and document them.
- Do NOT switch branches (no `git checkout`, `git switch`, `git stash branch`).
- Do NOT write `.result` files.
- Write `./implementation-log.md` before stopping.
