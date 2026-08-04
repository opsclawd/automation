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

Issue bodies intended to drive the orchestrator must follow the **Goldilocks format**: target approximately 1.5K–2K characters. Avoid both a roughly 400-character wishlist that forces the agent to guess and a roughly 5,000-character blueprint that over-specifies the solution. The target is a strong guideline, not a hard character limit; use enough detail to establish evidence, direction, and boundaries.

Every issue must include:

- `Goal` — the outcome the work must achieve.
- `Verified Evidence` — facts confirmed in the repository or runtime, with concrete paths, symbols, or observed behavior where useful.
- `Anchored Design` — the intended approach tied to existing code or documentation, while leaving implementation details to the agent.
- `Explicit Traps / Non-goals` — boundaries, known failure modes, and work that must not be included.
- `Acceptance Criteria` — observable conditions that define completion.
- `Open Questions` — resolved to `None`, `None.`, `N/A`, or `N/A.` before an orchestrator run starts.

The current orchestrator validation fails fast when `Goal` or `Acceptance Criteria` is missing, or when `Open Questions` is missing or unresolved. The Goldilocks length and the three additional sections are authoring requirements documented here; programmatic validation of them is outside this change.

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
