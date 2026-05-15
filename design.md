# Design Document: M1-01 — Bootstrap monorepo + tooling

## Problem Being Solved

The legacy `scripts/ai-run-issue-v2` and `scripts/ai-pr-review-poll` are unstable to operate and difficult to debug. The PRD (§13.1, §31) mandates wrapping them in a TypeScript/Node orchestrator with a Clean Architecture + DDD-lite layout. Before any feature work lands, the codebase needs:

- A workspace tool (`pnpm`)
- A TypeScript compiler config inherited by all packages
- A test runner (Vitest) and linter (ESLint) wired in
- CI that exercises all three so regressions are caught on PRs

This is the smallest possible vertical slice — no domain types, no SQLite, no UI. Just the shell.

## Key Design Decisions and Trade-offs Considered

### pnpm workspaces over Turborepo/Nx

**Decision:** Use `pnpm` workspaces, not Turborepo or Nx.

**Rationale:** The codebase is small enough that `pnpm -r <cmd>` is fast and predictable. We need a workspace tool, not a build orchestrator. pnpm's strict dependency hoisting also catches missing peer-deps early. Re-evaluate if cold-build time exceeds ~30s.

### pnpm 9.12.3 (pinned) over latest

**Decision:** Pin pnpm to `9.12.3` via `packageManager` field and `corepack`.

**Rationale:** Reproducibility across machines. `packageManager: "pnpm@9.12.3"` in root `package.json` enforces the version automatically via corepack.

### Node 22 LTS over latest

**Decision:** `.nvmrc` specifies `22`.

**Rationale:** Matches the runtime used by the existing Bash scripts and the PRD's assumption. Newer LTS will work but we match `.nvmrc` exactly.

### Vitest over Jest

**Decision:** Use Vitest 2.

**Rationale:** Native ESM + TypeScript with zero config beyond `vitest.config.ts`. Same JSDOM/Node test runner across all packages. `describe`/`it`/`expect` API is familiar.

### ESLint 9 flat config over legacy `.eslintrc`

**Decision:** Use ESLint 9 flat config (`eslint.config.mjs`).

**Rationale:** ESLint 9 is the current stable. Flat config is the direction ESLint is going. Works with `@typescript-eslint` v8.

### `@ai-sdlc/*` scoped package names

**Decision:** Use scope `@ai-sdlc/` for all workspace packages.

**Rationale:** Workspace identifier, not published to npm. Packages: `@ai-sdlc/shared`, `@ai-sdlc/domain`, `@ai-sdlc/application`, `@ai-sdlc/infrastructure`, `@ai-sdlc/api`, `@ai-sdlc/web`.

### `packages/*` + `apps/*` layout

**Decision:** Follow PRD §13.1 `apps/*` + `packages/*` layout.

**Rationale:** Explicit boundary between deployable applications (`apps/`) and reusable libraries (`packages/`). Follows conventional monorepo wisdom. MVP may collapse `apps/api` + `apps/worker` later.

### No `apps/web` test scaffolding yet

**Decision:** `apps/web` is a placeholder — no `tsconfig.json`, no `src/`, no test. Next.js owns its own scaffolding in a later issue (M1-07 / Task 7).

**Rationale:** Avoid premature lock-in of Next.js config. Keep the bootstrap minimal.

## Proposed Approach

### Files to create

**Root:**
- `package.json` — private, `"type": "module"`, `packageManager: "pnpm@9.12.3"`, devDeps: typescript, vitest, eslint, prettier, @typescript-eslint/*
- `pnpm-workspace.yaml` — `packages: ["apps/*", "packages/*"]`
- `tsconfig.base.json` — strict mode, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `moduleResolution: Bundler`
- `vitest.config.ts` — include `packages/**/__tests__/**/*.test.ts` and `apps/**/__tests__/**/*.test.ts`
- `eslint.config.mjs` — flat config, @typescript-eslint plugin, no-console warn (allow error/warn only)
- `.prettierrc.json` — semi, singleQuote, trailingComma all, printWidth 100
- `.editorconfig` — 2-space indent, lf, utf-8
- `.nvmrc` — `22`
- `.gitignore` — node_modules, dist, .next, coverage, *.tsbuildinfo, .ai-runs/, .ai-worktrees/, .DS_Store

**Packages (each has `package.json`, `tsconfig.json`, `src/index.ts`, `src/__tests__/smoke.test.ts`):**
- `packages/shared`
- `packages/domain`
- `packages/application`
- `packages/infrastructure`

**Apps:**
- `apps/api` — same pattern as packages (has smoke test)
- `apps/web` — minimal `package.json` placeholder only; no `tsconfig.json` or `src/` yet

**CI:**
- `.github/workflows/ci.yml` — runs on push to main and on PRs; steps: install, typecheck, lint, test

### Package shape

Each package (shared/domain/application/infrastructure/api):
- `package.json`: `"type": "module"`, name `@ai-sdlc/<name>`, scripts for `build` and `typecheck`
- `tsconfig.json`: extends `../../tsconfig.base.json`, `outDir: dist`, `rootDir: src`
- `src/index.ts`: exports `export const packageName = '@ai-sdlc/<name>'`
- `src/__tests__/smoke.test.ts`: `describe('@ai-sdlc/<name>')` → `expect(packageName).toBe('@ai-sdlc/<name>')`

`apps/web/package.json`: minimal placeholder with a no-op typecheck script.

### Root scripts

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

## Assumptions

1. **Node 22 is the target runtime** — as specified in `.nvmrc` and consistent with the existing Bash automation.
2. **pnpm 9.12.3 is the target workspace tool** — pinned in `packageManager` field; all developers use corepack to activate it.
3. **TypeScript strict mode is non-negotiable** — every subsequent story inherits from `tsconfig.base.json`. No relaxing of flags for convenience.
4. **apps/web placeholder is intentional** — Next.js scaffolding lands in M1-07 (Task 7). The placeholder is enough for `pnpm install` and `pnpm -r typecheck` to pass.
5. **No feature code in this issue** — no domain types, no SQLite, no route handlers, no React components.
6. **No Husky/lint-staged/commitlint** — deferred to a future issue if needed.
7. **No Turborepo/Nx** — pnpm workspaces are sufficient for M1 scope.
8. **CI uses `ubuntu-latest`** — standard GitHub Actions runner; no self-hosted runners.
9. **pnpm-lock.yaml is committed** — CI uses `--frozen-lockfile` so the lockfile must be in the repo.

## In Scope

- pnpm 9 workspace with packages: `packages/shared`, `packages/domain`, `packages/application`, `packages/infrastructure`, `apps/api`, `apps/web`
- `tsconfig.base.json` with strict flags: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`
- Per-package `tsconfig.json` extending the base
- Vitest 2 configured at root with single `vitest.config.ts`
- ESLint 9 flat config + `@typescript-eslint`
- Prettier 3 with standard config
- `.editorconfig`, `.nvmrc` ("22"), `.gitignore` additions
- GitHub Actions workflow CI running install, typecheck, lint, test on push to main and PRs

## Out of Scope

- Any application code (domain types, repositories, route handlers, React components)
- Husky / lint-staged / commitlint
- Turborepo / Nx
- `apps/web` Next.js scaffolding (deferred to Task 7)
- SQLite, better-sqlite3, or any persistence layer
- Config loaders (deferred to M1-02)
- Run directories, artifacts, or observability infrastructure

## Risks and Concerns

| Risk | Assessment |
|------|------------|
| ESLint flat config + @typescript-eslint v8 compatibility | Medium risk — verify versions in issue-comments.md match actual ESLint 9 behavior. The `eslint.config.mjs` in issue-comments.md uses named imports (`import tseslint from '@typescript-eslint/eslint-plugin'`) which is correct for v8. |
| `apps/web` placeholder causes `pnpm -r typecheck` to fail | Low risk — `apps/web` has a no-op typecheck script. The other 5 packages all have real `tsc -p tsconfig.json --noEmit`. |
| `pnpm install --frozen-lockfile` fails if lockfile is out of date | Low risk — lockfile will be committed as part of this issue. Developers must run `pnpm install` (not `--frozen-lockfile`) when adding dependencies. |
| Tests in `apps/web` don't exist yet | Accepted — explicitly out of scope. |
| `.ai-worktrees/` and `.ai-runs/` gitignore entries may conflict with existing usage | Low risk — these are new directories for the orchestrator; existing scripts don't use these names. |
| Node 22 requirement may limit contributor adoption | Low risk — Node 22 has been LTS since October 2024; most contributors will have it via nvm or system package managers. |