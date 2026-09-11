# Implement issue

## CONTEXT

{{var:WORKSPACE_CONSTRAINTS}}

Working directory: {{var:cwd}}
Issue number: {{var:issue_number}}

Issue description:
{{artifact?:issue.md}}

Issue comments:
{{artifact?:issue-comments.md}}

Design document:
{{artifact:design.md}}

Implementation plan:
{{artifact:plan.md}}

## TASK

Implement the GitHub issue completely.

Use the issue, comments, design, and plan provided above as the authoritative requirements and guidance.

Also read:
- `AGENTS.md`
- `CONTEXT.md`
- relevant ADRs and repository documentation
- the current implementation and relevant tests

Use the approved design and plan as guidance, but continue investigating the repository as you work. Make any reasonable changes required to implement the issue correctly, including helpers, callers, tests, fixtures, or adjacent code that the plan did not anticipate.

The GitHub issue remains authoritative. Do not silently violate its Anchored Design, Non-goals, or Acceptance Criteria.

Follow repository architecture and engineering conventions. Avoid unrelated cleanup or refactoring that is not justified by the implementation.

Add or update appropriate tests while working.

Implement the change completely and leave the worktree in a finished state for deterministic validation and independent review.

## VALIDATION SCOPE

Do not re-run the full repository validation suite yourself. A dedicated
validate/fix-validate phase runs the complete suite immediately after you
finish, with its own properly-sized per-command timeout - separate from
your invocation budget. Re-running it yourself risks exceeding your time
budget before you can write any result at all, which is worse than a
validation failure: it loses the entire turn, including your implementation.

{{var:SELF_VERIFY_INSTRUCTIONS}}

Do not run integration suites, Testcontainers-based tests, or
hardware/model-dependent suites (database integration tests, media
encoding/ML inference suites, GPU-dependent render tests, or any
repo-specific equivalent) yourself.

## FINAL ACTION

Write `./implementation-log.md` at the worktree root:

    Status: DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT

followed by a concise summary of changes and a `Files changed:` section listing all paths touched.

## CRITICAL RULES

- Do not ask questions. Make reasonable technical decisions and document them.
- Do not switch branches (no `git checkout`, `git switch`, `git stash branch`).
- Write `./implementation-log.md` before stopping.
