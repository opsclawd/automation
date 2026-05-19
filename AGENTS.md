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
- `packages/infrastructure/**` MUST NOT import `@ai-sdlc/application`.
- `packages/shared/**` has no workspace dependencies.
- `apps/web/**` is a browser bundle; it MUST NOT import `apps/api`,
  `@ai-sdlc/application`, or `@ai-sdlc/infrastructure`.

**Common red flag:** if you find yourself adding `@ai-sdlc/infrastructure` back
to `packages/application/package.json`, stop — you are about to break the layer
rule. Define a port instead. See `packages/application/src/ports.ts` for the
existing pattern (`RunRepositoryPort`, `RunDirectoryFactory`, `RunBashScriptFn`).

**Verifying locally before pushing:**

```
pnpm depcruise          # layer + circular-dep check
pnpm -r typecheck       # also catches missing workspace deps
pnpm -r test
pnpm lint
```

## Shell tests (bash / orchestrator scripts)

Shell-level tests for `scripts/` belong in **`scripts/lib/__tests__/`** as
**`.bats`** files (bats-core format). `pnpm test:bash` runs everything in that
directory; tests placed anywhere else (e.g. `scripts/__tests__/`) or in any
other format (plain `.sh`, plain `.test.sh`) will **not** be picked up by CI
and are effectively dead.

When testing a single function in isolation, extract it from the host script
with an `awk` brace-counter — this is robust against `}` characters inside
heredocs, which a naive `sed` range would not be. See
`scripts/lib/__tests__/validate_review_artifacts.bats` for a working example.
