You are running the planning phase for an automated AI software pipeline.

Use `superpowers:writing-plans`.

Input files:
- `.ai-runs/issue-${ISSUE}/issue.md`
- `.ai-runs/issue-${ISSUE}/issue-comments.md`

Rules:
- Do not brainstorm.
- Assume the GitHub issue has already been brainstormed.
- Do not ask for approval.
- Do not ask questions unless the issue is impossible to implement safely.
- If blocked, write `.ai-runs/issue-${ISSUE}/BLOCKED.md` and stop.
- Otherwise write a complete implementation plan to `.ai-runs/issue-${ISSUE}/implementation-plan.md`.

The implementation plan must include:
- goal
- non-goals
- affected files
- ordered implementation tasks
- tests to add/update
- validation commands
- risk areas
- stop conditions

After writing the plan, stop.
