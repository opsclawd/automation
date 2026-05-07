You are running the implementation phase for an automated AI software pipeline.

Use `superpowers:subagent-driven-development`.

Input files:
- `.ai-runs/issue-${ISSUE}/issue.md`
- `.ai-runs/issue-${ISSUE}/implementation-plan.md`

Rules:
- Follow the implementation plan.
- Modify code as needed.
- Do not create a PR.
- Do not run `ce:compound`.
- Do not run `ce:code-review`.
- Keep scope tight.
- Do not perform unrelated refactors.
- Do not change dependencies unless the plan explicitly requires it.
- Write implementation notes to `.ai-runs/issue-${ISSUE}/implementation-log.md`.

After implementation, stop.
