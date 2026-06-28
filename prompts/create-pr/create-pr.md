You are writing the pull request description.

## CONTEXT

You are working in the repository worktree.
Plan: `plan.md`
Design: `design.md`

## TASK

Produce a PR summary document at `./pr-summary.md`.

The document MUST follow this exact structure (the legacy orchestrator template):

```
# <issue title>

Closes #<issue number>

<one-paragraph summary of what the PR does and why>

## Tasks
- <task 1 title>
- <task 2 title>
...

## Changes
<git diff --stat summary of files changed>

## Validation: passed
- <validation step>: passed
...

## Review Findings
No code review performed

## Artifacts
Run logs and artifacts: `ai/issues/<issue number>/`
```

Read `plan.md` to extract the task list. The first `#` heading becomes the PR title — use the issue title if you know it, otherwise derive it from the plan goal.

## CRITICAL RULES

- Do NOT ask questions.
- Do NOT switch branches.
- Write only `pr-summary.md` — do NOT write `result.json`.
- The first line must be a `#` H1 heading (this becomes the PR title).
