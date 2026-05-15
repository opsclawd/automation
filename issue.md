# M1-01 — Bootstrap monorepo + tooling

> Story ID: **M1-01** · Milestone: **M1 Observable Bash Wrapper** · Type: `chore` · Area: `infra`

## Summary

Stand up the empty TypeScript monorepo that every subsequent M1 story will live in. After this issue is closed, a fresh clone can run `pnpm install && pnpm -r typecheck && pnpm lint && pnpm test` with green output and no application code yet.

## Why this exists

The legacy `scripts/ai-run-issue-v2` and `scripts/ai-pr-review-poll` are unstable to operate and difficult to debug. The PRD (§13.1, §31) decides we wrap them in a TypeScript/Node orchestrator with a Clean Architecture + DDD-lite layout. Before any feature work lands we need:

- a workspace tool (pnpm),
- a TypeScript compiler config that the rest of the codebase will inherit,
- a test runner (Vitest) and linter (ESLint) wired in,
- CI that exercises all three so regressions are caught on PRs.

This is the smallest possible vertical slice — no domain types, no SQLite, no UI. Just the shell.

## References

- PRD §13.1 "Recommended Project Structure" — `docs/ai-agent-sdlc-orchestrator-prd.md`
- Story map — `docs/milestone-stories.md` (M1-01)
- Implementation plan — `docs/superpowers/plans/2026-05-13-milestone-1-observable-bash-wrapper.md` (Task 1)

## In scope

- pnpm 9 workspace with the following packages, each exporting an empty `index.ts` and a passing placeholder test:
  - `packages/shared`
  - `packages/domain`
  - `packages/application`
  - `packages/infrastructure`
  - `apps/api`
  - `apps/web` (no test required — Next.js owns its own scaffolding later)
- `tsconfig.base.json` with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch` enabled.
- Per-package `tsconfig.json` extending the base.
- Vitest 2 configured at the root with a single `vitest.config.ts` whose `include` covers `packages/**/__tests__/**/*.test.ts` and `apps/**/__tests__/**/*.test.ts`.
- ESLint 9 flat config + `@typescript-eslint`, Prettier 3.
- `.editorconfig`, `.nvmrc` (`22`), `.gitignore` additions (`node_modules`, `dist`, `.next`, `coverage`, `*.tsbuildinfo`, `.ai-runs/`, `.ai-worktrees/`, `.DS_Store`).
- GitHub Actions workflow `.github/workflows/ci.yml` running `pnpm install --frozen-lockfile`, `pnpm -r typecheck`, `pnpm lint`, `pnpm test` on push to `main` and on PRs.

## Out of scope

- Any feature code. Do not create domain types, repositories, route handlers, React components, or config loaders here. Each has its own issue.
- Husky / lint-staged / commitlint. Optional later; not needed now.
- Turborepo / Nx. pnpm workspaces are sufficient for M1.

## Design

### Package naming

Use the `@ai-sdlc/*` scope. Concrete names: `@ai-sdlc/shared`, `@ai-sdlc/domain`, `@ai-sdlc/application`, `@ai-sdlc/infrastructure`, `@ai-sdlc/api`, `@ai-sdlc/web`. This scope is **not** published to npm — it's purely a workspace identifier.

### Why pnpm workspaces (and not Turbo/Nx)

We need a workspace tool, not a build orchestrator. The codebase is small enough that `pnpm -r <cmd>` is fast and predictable. Re-evaluate if cold-build time exceeds ~30s.

### Why Vitest

Native ESM + TypeScript with zero config beyond `vitest.config.ts`. Same JSDOM/Node test runner across packages.

### Layout

```
/
├─ package.json                      (private, "type": "module")
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
├─ vitest.config.ts
├─ eslint.config.mjs                 (flat config)
├─ .prettierrc.json
├─ .editorconfig
├─ .nvmrc                            "22"
├─ .gitignore                        (extended)
├─ .github/workflows/ci.yml
├─ apps/
│  ├─ api/                           empty placeholder
│  └─ web/                           empty placeholder
└─ packages/
   ├─ shared/
   ├─ domain/
   ├─ application/
   └─ infrastructure/
```

Each package's `src/index.ts` exports a single constant:

```ts
export const packageName = '@ai-sdlc/<name>';
```

Each has one smoke test asserting that constant.

### tsconfig.base.json (exact)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

Per-package `tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*"]
}
```

### Root package.json scripts (exact)

```json
{
  "build": "pnpm -r build",
  "test": "vitest run",
  "test:watch": "vitest",
  "lint": "eslint .",
  "format": "prettier --write .",
  "typecheck": "pnpm -r typecheck"
}
```

### CI

`.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9.12.3 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r typecheck
      - run: pnpm lint
      - run: pnpm test
```

## Acceptance criteria

- [ ] A fresh clone runs `corepack enable && pnpm install` with no errors.
- [ ] `pnpm -r typecheck` exits 0.
- [ ] `pnpm lint` exits 0 with no warnings.
- [ ] `pnpm test` runs at least one test per package (`shared`, `domain`, `application`, `infrastructure`, `api`) and exits 0.
- [ ] GitHub Actions runs the four commands above on this PR and they pass.
- [ ] `pnpm-lock.yaml` is committed.
- [ ] `.gitignore` excludes `node_modules`, `dist`, `.next`, `coverage`, `.ai-runs/`, `.ai-worktrees/`.

## Test plan

1. Clone the branch into a clean directory.
2. `corepack enable && corepack prepare pnpm@9.12.3 --activate && pnpm install`.
3. Run `pnpm -r typecheck && pnpm lint && pnpm test`.
4. Inspect CI on the PR — all four steps green.

## Dependencies

None. This is the first M1 issue.

## Definition of done

- All acceptance criteria checked.
- CI green on the PR.
- No app/domain code committed (this issue should not change files outside the listed scope).
- PR description links back to this issue.

## Notes for the implementer

- Use **Node 22** specifically. Newer LTS will work, but match `.nvmrc`.
- Use **pnpm 9.12.3** specifically. Pin via `packageManager` in root `package.json` and via `corepack prepare`.
- Do **not** install dependencies you don't need yet (no Fastify, no better-sqlite3, no Zod). Those land in later issues.
- If you find yourself writing application logic to make a test pass, you've left the scope of this issue. Stop.

