## Before opening a PR — mandatory, not optional

Run all four of these and confirm every one passes. **Do not open a PR, and do
not report work as done, if any of these fail:**

```
pnpm -r build      # exact command CI runs first — catches TypeScript build errors
pnpm -r typecheck  # per-package tsc --noEmit — catches missing workspace deps too
pnpm lint          # eslint --max-warnings=0 — unused vars, no-explicit-any, etc.
pnpm -r test       # full suite — catches regressions in tests you didn't touch
```

This is not a suggestion or a nice-to-have — every one of these is enforced by
CI on every PR, and a PR that fails any of them will not be merged. Fixing a
red PR after the fact costs more (a human or another agent has to notice,
diagnose, and push a follow-up commit) than running four commands before the
first push. If a command fails, fix the failure and re-run all four again —
do not open the PR with a known-red check on the assumption it can be fixed
later.

## Agent skills

### Issue tracker

GitHub Issues via `gh` are the intake surface for this repo's automation work and follow-up. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the repo's automation labels: `ai:in-progress`, `ai:blocked`, `ai:failed`, `ai:needs-human-review`, `ai:pr-ready`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context. Read root `CONTEXT.md`, the relevant ADRs in `docs/adr/`, and `docs/design-decisions-report.md` when working on orchestration behavior. See `docs/agents/domain.md`.

### Documented solutions

`docs/solutions/` — documented solutions to past problems (bugs, best practices, workflow patterns), organized by category with YAML frontmatter (`module`, `tags`, `problem_type`). Relevant when implementing or debugging in documented areas.

## Layer boundaries (hard rule)

The orchestrator is structured as concentric layers. Dependencies flow **inward only**:

```
shared  <--  domain  <--  application  <--  apps/api (composition root)
                                  ^
                                  |
                          infrastructure  <--  apps/api
```

**Hard rules — enforced by `pnpm depcruise` in CI:**

- `packages/application/**` MUST NOT import `@ai-sdlc/infrastructure`.
  - If you need a side effect (DB write, file I/O, subprocess), define a **port**
    (interface or function type) in `packages/application/src/ports.ts` and add
    a parameter to the use case's `Deps`. The infra adapter is injected from
    `apps/api/src/compose.ts` — the only legal cross-layer wiring point.
- `packages/domain/**` may only import `@ai-sdlc/shared`. Domain is pure.
- `packages/infrastructure/**` may import application **port contracts only** (types and constants in `packages/application/src/ports/`). Infrastructure must not import application use cases, orchestration services, test doubles, or runtime implementation modules. All runtime wiring remains in `apps/api/src/compose.ts`.
  - Infrastructure **tests** may import `@ai-sdlc/application/test-doubles` for port fakes.
- `packages/shared/**` has no workspace dependencies.
- `apps/web/**` is a browser bundle; it MUST NOT import `apps/api`,
  `@ai-sdlc/application`, or `@ai-sdlc/infrastructure`.

**Common red flag:** if you find yourself adding `@ai-sdlc/infrastructure` back
to `packages/application/package.json`, stop — you are about to break the layer
rule. Define a port instead. See `packages/application/src/ports.ts` for the
existing pattern (`RunRepositoryPort`, `RunDirectoryFactory`, `RunBashScriptFn`).

**Verifying locally before pushing:** see "Before opening a PR" at the top of
this file — also add `pnpm depcruise` (layer + circular-dep check) when
touching imports across `packages/`/`apps/` boundaries.

**Shell tests** for `scripts/` belong in `scripts/lib/__tests__/*.bats` — anything
else is silently ignored by `pnpm test:bash`. See
`docs/solutions/orchestrator/shell-test-location-2026-05-19.md`.
