# Pull Request Summary for Issue #{{var:issue_number}}

## CONTEXT
Plan: {{artifact:plan.md}}

## TASK
You are drafting the pull request description for GitHub issue #{{var:issue_number}}.

Produce a **PR summary** (`pr-summary.md`) that includes:
- A short, descriptive title as an H1 heading (this becomes the PR title)
- A summary section explaining what the PR does and why
- A list of key changes made (files touched, behaviour changed)
- A test plan: how to verify the changes work correctly

The first `#` heading line in `pr-summary.md` is used as the PR title, so make it concise and descriptive.

Output format:
- `pr-summary.md`: a Markdown document starting with an H1 title heading

## CRITICAL RULES
- Do NOT ask questions.
- Do NOT switch branches.
- Write only `pr-summary.md` — do NOT write `result.json`.
- Do NOT reference or use `compound.md` — it may not exist.
