You are running an automated, non-interactive planning phase.

The GitHub issue has already been brainstormed and approved by a human.

The presence of the `ai:plan-ready` label is explicit authorization to write the implementation plan.

Use `superpowers:writing-plans` only for its planning structure and thoroughness.

Do not ask for confirmation.
Do not ask whether to write the plan.
Do not wait for approval.
Do not say "I can write this up."
Do not present the plan in chat and ask if it should be saved.

You must write the implementation plan directly to:

`.ai-runs/issue-${ISSUE}/implementation-plan.md`

Input files:
- `.ai-runs/issue-${ISSUE}/issue.md`
- `.ai-runs/issue-${ISSUE}/issue-comments.md`
- `.ai-runs/issue-${ISSUE}/repo-files.txt` if it exists
- `graphify-out/GRAPH_REPORT.md` if it exists

Hard context rules:
- Do not recursively scan the repository.
- Use `GRAPH_REPORT.md` as the repo architecture map if available.
- Use `repo-files.txt` as the file map if available.
- Do not inspect `.ai-runs/`, `.ai-worktrees/`, `.git/`, `node_modules/`, `dist/`, `build/`, `coverage/`, `.next/`, `.turbo/`, or `graphify-out/cache/`.
- Inspect no more than 20 source files during planning unless absolutely required.

Rules:
- Do not brainstorm.
- Do not ask questions unless implementation would be unsafe or impossible.
- If blocked, write `.ai-runs/issue-${ISSUE}/BLOCKED.md` and stop.
- Otherwise write the complete implementation plan file.

The implementation plan must include:
- goal
- non-goals
- approved design summary
- affected files
- ordered implementation tasks
- tests to add/update
- validation commands
- risk areas
- stop conditions

After writing `.ai-runs/issue-${ISSUE}/implementation-plan.md`, stop.
