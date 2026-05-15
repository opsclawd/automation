# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- `CONTEXT.md` at the repo root.
- `docs/adr/` - read the ADRs that touch the area you're about to work in.
- `docs/design-decisions-report.md` - read this when the work depends on resolved orchestration decisions or lifecycle semantics.

If any of these files don't exist, proceed silently. Don't flag their absence; don't suggest creating them upfront.

## File structure

Repo structure:

```
/
├── CONTEXT.md (for vocabulary and invariants)
├── docs
│   ├── adr (for decisions future agents must preserve)
│   ├── solutions (for issues you solved and don’t want to solve twice)
│   ├── prd.md
│   └── design-decisions-report.md
│   └── project-brief.md
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal - either you're inventing language the project doesn't use or there's a real gap. Note it for `/grill-with-docs`.

Prefer the repo's domain terms:

- Run
- Phase
- Step
- Loop
- Agent Invocation
- Artifact

Prefer the lifecycle states from `CONTEXT.md`:

- RUNNING
- READY
- SUCCESS
- FAILED
- CANCELLED

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding it:

> _Contradicts ADR-0007 (event-sourced orders) - but worth reopening because..._

If a conclusion conflicts with `docs/design-decisions-report.md`, call that out as a design-decision mismatch and prefer the repo docs over generic guidance.
