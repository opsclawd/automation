# Issue tracker: GitHub

GitHub Issues are the repo's intake and tracking surface for automation work, bugs, and follow-up. Use the `gh` CLI for all issue and PR operations.

The long-form architecture and product docs live in `docs/`, not in issues. Use issues to track work, not to replace the repo's domain documentation.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, then inspect labels and comments as needed.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments`.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v`; `gh` does this automatically inside a clone.

## For orchestrator runs

Issue bodies intended to drive `scripts/ai-run-issue-v2` must include:

- `Goal`
- `Acceptance Criteria`
- `Open Questions` resolved to `None`, `None.`, `N/A`, or `N/A.`

The orchestrator validates those sections and will fail fast if the issue body is incomplete or still has unresolved open questions.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Repo labels used by automation

The workflow scripts manage these labels as state markers:

- `ai:in-progress`
- `ai:blocked`
- `ai:failed`
- `ai:needs-human-review`
- `ai:pr-ready`
