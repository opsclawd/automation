# Milestone 1 — Observable Bash Wrapper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap the existing `scripts/ai-run-issue-v2` Bash script in a TypeScript orchestrator so every run produces a stable run directory, persisted SQLite metadata, captured stdout/stderr, a structured failure file, and a minimal web UI to inspect runs.

**Architecture:** pnpm-workspaces monorepo. `packages/{domain,application,infrastructure,shared}` follow Clean Architecture + DDD-lite (PRD §13, §14). `apps/api` exposes a Fastify HTTP+SSE server; `apps/web` is a Next.js 15 dashboard. Persistence is SQLite (better-sqlite3) for metadata and filesystem under `.ai-runs/<displayId>/` for artifacts (per design Q12, Q15). The TypeScript wrapper does not modify the legacy Bash script — it spawns it via `execa`, tees its output, and treats its exit code as the source of truth for pass/fail in M1.

**Tech Stack:**
- Node 22 LTS, pnpm 9, TypeScript 5.6 strict
- Vitest 2 (unit + integration), Playwright 1.48 (UI smoke), Zod 3 (schemas)
- better-sqlite3 11 (sync embedded SQLite), execa 9 (process spawning), uuid 10
- Fastify 5 (HTTP + SSE), Pino logging
- Next.js 15 (App Router), Tailwind CSS 4, shadcn/ui (Radix primitives + cva)
- ESLint 9 (flat config) + @typescript-eslint, Prettier 3
- GitHub Actions CI

**Source references:**
- PRD: `docs/ai-agent-sdlc-orchestrator-prd.md` (§13 layered architecture, §15 data model, §16.2 MVP features, §22 storage layout, §23 API, §24 UX, §29 M1)
- Decisions: `docs/design-decisions-report.md` (Q1, Q12, Q15, Q22, Q26)
- Story map: `docs/milestone-stories.md` (M1-01 … M1-08)
- Legacy scripts (do not modify in M1): `scripts/ai-run-issue-v2`, `scripts/ai-pr-review-poll`

---

## File Structure (locked-in decomposition)

```
automation/
├─ package.json                              (root, private)
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
├─ .editorconfig
├─ .nvmrc                                    "22"
├─ .gitignore                                (add .ai-runs/, .ai-worktrees/, node_modules, dist, .next, coverage)
├─ .ai-orchestrator.json                     (sample config, Q26 shape)
├─ eslint.config.mjs                         (flat config, shared)
├─ .prettierrc.json
├─ vitest.config.ts                          (root, projects)
├─ .github/workflows/ci.yml
│
├─ packages/
│  ├─ shared/                                cross-package utilities, no infra deps
│  │  ├─ package.json
│  │  ├─ tsconfig.json
│  │  └─ src/
│  │     ├─ index.ts
│  │     ├─ config/
│  │     │  ├─ schema.ts                     Zod schema for .ai-orchestrator.json
│  │     │  ├─ loader.ts                     loadConfig(repoRoot)
│  │     │  ├─ errors.ts                     ConfigError class
│  │     │  └─ __tests__/loader.test.ts
│  │     ├─ ids/
│  │     │  ├─ run-id.ts                     newRunId(issueNumber, now): {uuid, displayId}
│  │     │  └─ __tests__/run-id.test.ts
│  │     └─ events/
│  │        └─ schema.ts                     Zod schema for events.jsonl rows (used by M2 too)
│  │
│  ├─ domain/                                pure domain, no infra imports
│  │  ├─ package.json
│  │  ├─ tsconfig.json
│  │  └─ src/
│  │     ├─ index.ts
│  │     ├─ run.ts                           Run type + transition helpers
│  │     ├─ phase.ts                         Phase type
│  │     ├─ failure.ts                       Failure type + kinds enum
│  │     ├─ artifact.ts                      Artifact type
│  │     └─ __tests__/run.test.ts
│  │
│  ├─ infrastructure/                        adapters (filesystem, sqlite, exec)
│  │  ├─ package.json
│  │  ├─ tsconfig.json
│  │  └─ src/
│  │     ├─ index.ts
│  │     ├─ run-directory.ts                 RunDirectory.create / paths / write run.json atomically
│  │     ├─ sqlite/
│  │     │  ├─ database.ts                   openDatabase(path)
│  │     │  ├─ migrations.ts                 applyMigrations(db)
│  │     │  ├─ migrations/0001-init.ts      SQL inlined (survives tsc build)
│  │     │  ├─ run-repository.ts             RunRepository
│  │     │  ├─ phase-repository.ts           PhaseRepository
│  │     │  ├─ event-repository.ts           EventRepository
│  │     │  ├─ artifact-repository.ts        ArtifactRepository
│  │     │  ├─ failure-repository.ts         FailureRepository
│  │     │  └─ __tests__/                    one test per repo against a temp file DB
│  │     ├─ bash/
│  │     │  ├─ run-bash-script.ts            spawn legacy script, tee logs, record exit
│  │     │  └─ __tests__/run-bash-script.test.ts
│  │     └─ failure/
│  │        ├─ classifier.ts                 classifyExit(exitCode, combinedLog): Failure
│  │        └─ __tests__/classifier.test.ts
│  │
│  └─ application/                           use cases (composition lives in apps/api)
│     ├─ package.json
│     ├─ tsconfig.json
│     └─ src/
│        ├─ index.ts
│        ├─ start-issue-run.ts               StartIssueRun use case
│        └─ __tests__/start-issue-run.test.ts
│
├─ apps/
│  ├─ api/                                   Fastify server + CLI entry
│  │  ├─ package.json
│  │  ├─ tsconfig.json
│  │  └─ src/
│  │     ├─ compose.ts                       composeRoot(): Container
│  │     ├─ server.ts                        Fastify routes
│  │     ├─ routes/
│  │     │  ├─ runs.ts                       GET /api/runs, GET /api/runs/:id
│  │     │  └─ artifacts.ts                  GET /api/runs/:id/artifacts, /artifacts/*
│  │     ├─ cli.ts                           `orchestrator` CLI (commander)
│  │     └─ __tests__/routes.test.ts
│  │
│  └─ web/                                   Next.js dashboard
│     ├─ package.json
│     ├─ tsconfig.json
│     ├─ next.config.mjs
│     ├─ postcss.config.mjs
│     ├─ tailwind.config.ts
│     ├─ components.json                     shadcn/ui
│     ├─ src/
│     │  ├─ app/
│     │  │  ├─ layout.tsx
│     │  │  ├─ globals.css
│     │  │  ├─ page.tsx                      run list
│     │  │  └─ runs/[id]/page.tsx            run detail
│     │  ├─ components/
│     │  │  ├─ ui/                           shadcn primitives (button, card, table, tabs)
│     │  │  ├─ run-list-table.tsx
│     │  │  ├─ log-viewer.tsx
│     │  │  ├─ artifact-tree.tsx
│     │  │  └─ failure-panel.tsx
│     │  └─ lib/
│     │     ├─ api-client.ts                 typed fetch wrappers
│     │     └─ format.ts                     duration, status badge helpers
│     └─ e2e/
│        └─ smoke.spec.ts                    Playwright
│
└─ scripts/
   └─ ai-run-issue-v2                        UNCHANGED in M1
```

**Decomposition rules:**
- Each repository file is one class with one table.
- `compose.ts` is the only file that imports both `infrastructure` and `application`.
- `apps/web` only talks to `apps/api` over HTTP — never imports `packages/*`.
- All filesystem and process side-effects live in `packages/infrastructure`.

---

## Conventions used in every task

- **TDD:** write a failing test → run it → minimal impl → run again → commit.
- **Commits:** Conventional Commits (`feat:`, `fix:`, `chore:`, `test:`, `docs:`). One commit per task unless a task explicitly says otherwise.
- **Test runner:** `pnpm -w test` runs every project's Vitest. To run one file: `pnpm --filter @ai-sdlc/<package> test -- <file>`.
- **Strict TS:** every `tsconfig.json` extends `tsconfig.base.json` which sets `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`.
- **Package names:** `@ai-sdlc/shared`, `@ai-sdlc/domain`, `@ai-sdlc/application`, `@ai-sdlc/infrastructure`, `@ai-sdlc/api`, `@ai-sdlc/web`.
- **Imports between packages:** by package name, never by relative path across package boundaries.

---

# Task 1 — Bootstrap monorepo + tooling (story M1-01)

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.editorconfig`, `.nvmrc`, `.gitignore` (update), `eslint.config.mjs`, `.prettierrc.json`, `vitest.config.ts`
- Create: `packages/{shared,domain,application,infrastructure}/package.json`, `tsconfig.json`, `src/index.ts`, `src/__tests__/smoke.test.ts`
- Create: `apps/{api,web}/package.json`, `tsconfig.json`, placeholder `src/index.ts`
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1.1: Pin Node and set up workspace files**

Create `.nvmrc`:
```
22
```

Create `pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

Create `.editorconfig`:
```ini
root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = true
```

Append to `.gitignore` (create if missing):
```
node_modules
dist
.next
coverage
*.tsbuildinfo
.ai-runs/
.ai-worktrees/
.DS_Store
```

- [ ] **Step 1.2: Create root `package.json`**

Create `package.json`:
```json
{
  "name": "ai-sdlc-orchestrator",
  "private": true,
  "version": "0.0.0",
  "packageManager": "pnpm@9.12.3",
  "engines": {
    "node": ">=22.0.0",
    "pnpm": ">=9.0.0"
  },
  "scripts": {
    "build": "pnpm -r build",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint .",
    "format": "prettier --write .",
    "typecheck": "pnpm -r typecheck"
  },
  "devDependencies": {
    "@types/node": "^22.9.0",
    "@typescript-eslint/eslint-plugin": "^8.13.0",
    "@typescript-eslint/parser": "^8.13.0",
    "eslint": "^9.14.0",
    "prettier": "^3.3.3",
    "typescript": "^5.6.3",
    "vitest": "^2.1.4"
  }
}
```

- [ ] **Step 1.3: Create `tsconfig.base.json`**

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

- [ ] **Step 1.4: Create `.prettierrc.json` and `eslint.config.mjs`**

`.prettierrc.json`:
```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "arrowParens": "always"
}
```

`eslint.config.mjs`:
```js
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/node_modules/**',
      'apps/web/next-env.d.ts',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['warn', { allow: ['error', 'warn'] }],
    },
  },
];
```

- [ ] **Step 1.5: Create root `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/__tests__/**/*.test.ts', 'apps/**/__tests__/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
    },
  },
});
```

- [ ] **Step 1.6: Scaffold each package and app with a smoke test**

Repeat for `packages/shared`, `packages/domain`, `packages/application`, `packages/infrastructure`:

`packages/<name>/package.json` (replace `<name>` and bump deps later as needed):
```json
{
  "name": "@ai-sdlc/<name>",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

`packages/<name>/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
}
```

`packages/<name>/src/index.ts`:
```ts
export const packageName = '@ai-sdlc/<name>';
```

`packages/<name>/src/__tests__/smoke.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { packageName } from '../index.js';

describe('@ai-sdlc/<name>', () => {
  it('exports a package name', () => {
    expect(packageName).toBe('@ai-sdlc/<name>');
  });
});
```

Then scaffold the two apps. **`apps/api` gets a smoke test in M1-01** (the M1-05 acceptance criteria require one test per package including api). **`apps/web` does not** — its scaffolding lands in Task 7.

`apps/api/package.json` (minimal — full deps land in Task 5):
```json
{
  "name": "@ai-sdlc/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

`apps/api/tsconfig.json`: same shape as `packages/<name>/tsconfig.json`.

`apps/api/src/index.ts`:
```ts
export const packageName = '@ai-sdlc/api';
```

`apps/api/src/__tests__/smoke.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { packageName } from '../index.js';

describe('@ai-sdlc/api', () => {
  it('exports a package name', () => {
    expect(packageName).toBe('@ai-sdlc/api');
  });
});
```

`apps/web/package.json` (placeholder — Next.js scaffolding lands in Task 7):
```json
{
  "name": "@ai-sdlc/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "typecheck": "echo 'no-op until Task 7'" }
}
```

Do **not** create an `apps/web/tsconfig.json` or any `src/` content yet — those land in Task 7. The empty placeholder is enough for `pnpm install` and `pnpm -r typecheck` to succeed.

- [ ] **Step 1.7: Install dependencies**

Run:
```bash
corepack enable
corepack prepare pnpm@9.12.3 --activate
pnpm install
```

Expected: lockfile created, no errors.

- [ ] **Step 1.8: Verify build / typecheck / lint / test all pass**

Run sequentially and expect each to exit 0:
```bash
pnpm -r typecheck
pnpm lint
pnpm test
```

Expected: smoke test in each package prints PASS, no errors.

- [ ] **Step 1.9: Add CI workflow**

Create `.github/workflows/ci.yml`:
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
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r typecheck
      - run: pnpm lint
      - run: pnpm test
```

- [ ] **Step 1.10: Commit**

```bash
git add -A
git commit -m "chore: bootstrap pnpm workspace, tsconfig, eslint, vitest, CI"
```

---

# Task 2 — `.ai-orchestrator.json` schema and loader (story M1-02)

**Files:**
- Create: `packages/shared/src/config/schema.ts`
- Create: `packages/shared/src/config/loader.ts`
- Create: `packages/shared/src/config/errors.ts`
- Create: `packages/shared/src/config/__tests__/loader.test.ts`
- Modify: `packages/shared/src/index.ts` (export config module)
- Modify: `packages/shared/package.json` (add `zod` dependency)
- Create: `.ai-orchestrator.json` (sample at repo root)

- [ ] **Step 2.1: Add zod dependency**

Run:
```bash
pnpm --filter @ai-sdlc/shared add zod@^3.23.8
```

- [ ] **Step 2.2: Write failing tests for the loader**

Create `packages/shared/src/config/__tests__/loader.test.ts`:
```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../loader.js';
import { ConfigError } from '../errors.js';

function makeRepo(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-cfg-'));
  if (contents !== undefined) writeFileSync(join(dir, '.ai-orchestrator.json'), contents);
  return dir;
}

describe('loadConfig', () => {
  it('parses a valid config', () => {
    const repo = makeRepo(
      JSON.stringify({
        validation: { commands: ['pnpm build'], timeout: 300 },
        phases: { skip: ['compound'], reviewFix: { maxIterations: 10 }, implement: { maxIterations: 5 } },
        timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
      }),
    );
    const cfg = loadConfig(repo);
    expect(cfg.validation.commands).toEqual(['pnpm build']);
    expect(cfg.phases.skip).toEqual(['compound']);
    expect(cfg.timeouts.readyMaxDays).toBe(7);
  });

  it('throws ConfigError when file is missing', () => {
    const repo = makeRepo();
    expect(() => loadConfig(repo)).toThrow(ConfigError);
    expect(() => loadConfig(repo)).toThrow(/\.ai-orchestrator\.json/);
  });

  it('throws ConfigError with field path on invalid value', () => {
    const repo = makeRepo(
      JSON.stringify({
        validation: { commands: [], timeout: -1 },
        phases: { skip: [], reviewFix: { maxIterations: 10 }, implement: { maxIterations: 5 } },
        timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
      }),
    );
    expect(() => loadConfig(repo)).toThrow(/validation\.timeout/);
  });

  it('throws ConfigError when JSON is malformed', () => {
    const repo = makeRepo('{ not json');
    expect(() => loadConfig(repo)).toThrow(ConfigError);
  });
});
```

- [ ] **Step 2.3: Run the test — expect failure**

```bash
pnpm --filter @ai-sdlc/shared test
```

Expected: imports fail because `loader.ts`/`errors.ts` don't exist.

- [ ] **Step 2.4: Implement `errors.ts`**

Create `packages/shared/src/config/errors.ts`:
```ts
export class ConfigError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ConfigError';
  }
}
```

- [ ] **Step 2.5: Implement `schema.ts`**

Create `packages/shared/src/config/schema.ts`:
```ts
import { z } from 'zod';

export const orchestratorConfigSchema = z.object({
  validation: z.object({
    commands: z.array(z.string().min(1)).min(1),
    timeout: z.number().int().positive(),
  }),
  phases: z.object({
    skip: z.array(z.string()).default([]),
    reviewFix: z.object({ maxIterations: z.number().int().positive() }),
    implement: z.object({ maxIterations: z.number().int().positive() }),
  }),
  timeouts: z.object({
    readyMaxDays: z.number().int().positive(),
    invocationMaxMinutes: z.number().int().positive(),
  }),
});

export type OrchestratorConfig = z.infer<typeof orchestratorConfigSchema>;
```

- [ ] **Step 2.6: Implement `loader.ts`**

Create `packages/shared/src/config/loader.ts`:
```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { ConfigError } from './errors.js';
import { orchestratorConfigSchema, type OrchestratorConfig } from './schema.js';

const CONFIG_FILENAME = '.ai-orchestrator.json';

export function loadConfig(repoRoot: string): OrchestratorConfig {
  const path = join(repoRoot, CONFIG_FILENAME);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`Missing ${CONFIG_FILENAME} at ${path}`, err);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`Invalid JSON in ${CONFIG_FILENAME}: ${(err as Error).message}`, err);
  }
  const parsed = orchestratorConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new ConfigError(formatZodError(parsed.error), parsed.error);
  }
  return parsed.data;
}

function formatZodError(err: ZodError): string {
  return err.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}
```

- [ ] **Step 2.7: Re-export from `packages/shared/src/index.ts`**

Replace contents of `packages/shared/src/index.ts`:
```ts
export const packageName = '@ai-sdlc/shared';
export * from './config/schema.js';
export * from './config/loader.js';
export * from './config/errors.js';
```

- [ ] **Step 2.8: Run tests — expect PASS**

```bash
pnpm --filter @ai-sdlc/shared test
```

Expected: all four tests pass.

- [ ] **Step 2.9: Commit the sample config**

Create `.ai-orchestrator.json` at repo root:
```json
{
  "validation": {
    "commands": ["pnpm build", "pnpm lint", "pnpm typecheck", "pnpm test"],
    "timeout": 300
  },
  "phases": {
    "skip": ["compound"],
    "reviewFix": { "maxIterations": 10 },
    "implement": { "maxIterations": 5 }
  },
  "timeouts": {
    "readyMaxDays": 7,
    "invocationMaxMinutes": 30
  }
}
```

- [ ] **Step 2.10: Commit**

```bash
git add packages/shared .ai-orchestrator.json
git commit -m "feat(config): add .ai-orchestrator.json schema and loader"
```

---

# Task 3 — Run identity + directory layout (story M1-03)

**Files:**
- Create: `packages/shared/src/ids/run-id.ts`
- Create: `packages/shared/src/ids/__tests__/run-id.test.ts`
- Modify: `packages/shared/src/index.ts` (export ids)
- Modify: `packages/shared/package.json` (add `uuid`)
- Create: `packages/domain/src/run.ts`, `phase.ts`, `failure.ts`, `artifact.ts`
- Create: `packages/domain/src/__tests__/run.test.ts`
- Modify: `packages/domain/src/index.ts`
- Create: `packages/infrastructure/src/run-directory.ts`
- Create: `packages/infrastructure/src/__tests__/run-directory.test.ts`
- Modify: `packages/infrastructure/src/index.ts`
- Modify: `packages/infrastructure/package.json` (add `@ai-sdlc/shared`, `@ai-sdlc/domain` workspace deps)

- [ ] **Step 3.1: Add uuid dependency**

```bash
pnpm --filter @ai-sdlc/shared add uuid@^10.0.0
pnpm --filter @ai-sdlc/shared add -D @types/uuid@^10.0.0
```

- [ ] **Step 3.2: Write failing test for `newRunId`**

Create `packages/shared/src/ids/__tests__/run-id.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { newRunId } from '../run-id.js';

describe('newRunId', () => {
  it('produces a UUID and a deterministic displayId', () => {
    const at = new Date('2026-05-13T19:23:00.000Z');
    const id = newRunId({ issueNumber: 123, now: at });
    expect(id.displayId).toBe('issue-123-20260513-192300');
    expect(id.uuid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('zero-pads single digit time components', () => {
    const at = new Date('2026-01-02T03:04:05.000Z');
    const id = newRunId({ issueNumber: 7, now: at });
    expect(id.displayId).toBe('issue-7-20260102-030405');
  });

  it('produces unique UUIDs across calls', () => {
    const at = new Date('2026-05-13T19:23:00.000Z');
    const a = newRunId({ issueNumber: 1, now: at });
    const b = newRunId({ issueNumber: 1, now: at });
    expect(a.uuid).not.toBe(b.uuid);
  });
});
```

- [ ] **Step 3.3: Implement `run-id.ts`**

Create `packages/shared/src/ids/run-id.ts`:
```ts
import { v4 as uuidv4 } from 'uuid';

export interface NewRunIdInput {
  issueNumber: number;
  now: Date;
}

export interface RunIdentity {
  uuid: string;
  displayId: string;
}

export function newRunId(input: NewRunIdInput): RunIdentity {
  const ts = formatTimestamp(input.now);
  return {
    uuid: uuidv4(),
    displayId: `issue-${input.issueNumber}-${ts}`,
  };
}

function formatTimestamp(d: Date): string {
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}
```

- [ ] **Step 3.4: Export from shared index**

Append to `packages/shared/src/index.ts`:
```ts
export * from './ids/run-id.js';
```

- [ ] **Step 3.5: Run tests — expect PASS**

```bash
pnpm --filter @ai-sdlc/shared test
```

- [ ] **Step 3.6: Write failing test for domain `Run`**

Create `packages/domain/src/__tests__/run.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { createRun, startPhase, completePhase, failRun, type Run } from '../run.js';

const base = {
  uuid: '11111111-1111-1111-1111-111111111111',
  displayId: 'issue-1-20260513-000000',
  issueNumber: 1,
  startedAt: new Date('2026-05-13T00:00:00Z'),
};

describe('Run state machine', () => {
  it('starts in running with no current phase', () => {
    const r = createRun(base);
    expect(r.status).toBe('running');
    expect(r.currentPhase).toBeUndefined();
  });

  it('transitions current phase', () => {
    let r = createRun(base);
    r = startPhase(r, 'read_issue');
    expect(r.currentPhase).toBe('read_issue');
  });

  it('marks completed phases', () => {
    let r = createRun(base);
    r = startPhase(r, 'read_issue');
    r = completePhase(r, 'read_issue');
    expect(r.completedPhases).toEqual(['read_issue']);
  });

  it('fails with reason', () => {
    const r = failRun(createRun(base), 'boom');
    expect(r.status).toBe('failed');
    expect(r.failureReason).toBe('boom');
  });
});
```

- [ ] **Step 3.7: Implement domain types**

Create `packages/domain/src/run.ts`:
```ts
export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'passed'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'needs_human_review';

export interface Run {
  uuid: string;
  displayId: string;
  issueNumber: number;
  type: 'issue_to_pr' | 'pr_review';
  status: RunStatus;
  currentPhase?: string;
  completedPhases: string[];
  startedAt: Date;
  completedAt?: Date;
  failureReason?: string;
}

export interface CreateRunInput {
  uuid: string;
  displayId: string;
  issueNumber: number;
  startedAt: Date;
  type?: 'issue_to_pr' | 'pr_review';
}

export function createRun(input: CreateRunInput): Run {
  return {
    uuid: input.uuid,
    displayId: input.displayId,
    issueNumber: input.issueNumber,
    type: input.type ?? 'issue_to_pr',
    status: 'running',
    completedPhases: [],
    startedAt: input.startedAt,
  };
}

export function startPhase(run: Run, phase: string): Run {
  return { ...run, currentPhase: phase };
}

export function completePhase(run: Run, phase: string): Run {
  return {
    ...run,
    completedPhases: [...run.completedPhases, phase],
    currentPhase: undefined,
  };
}

export function passRun(run: Run, at: Date): Run {
  return { ...run, status: 'passed', completedAt: at, currentPhase: undefined };
}

export function failRun(run: Run, reason: string, at: Date = new Date()): Run {
  return { ...run, status: 'failed', completedAt: at, failureReason: reason };
}
```

Create `packages/domain/src/phase.ts`:
```ts
export type PhaseStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'blocked';

export interface Phase {
  id: string;
  runUuid: string;
  name: string;
  status: PhaseStatus;
  attempt: number;
  startedAt?: Date;
  completedAt?: Date;
}
```

Create `packages/domain/src/failure.ts`:
```ts
export type FailureKind =
  | 'command_failed'
  | 'timeout'
  | 'missing_artifact'
  | 'invalid_result'
  | 'agent_blocked'
  | 'agent_contract_violation'
  | 'branch_changed'
  | 'validation_failed'
  | 'github_failed'
  | 'git_failed'
  | 'polling_failed'
  | 'unknown';

export interface Failure {
  runUuid: string;
  phase?: string;
  step?: string;
  attempt?: number;
  kind: FailureKind;
  message: string;
  exitCode?: number;
  canRetry: boolean;
  suggestedAction: string;
  artifacts: string[];
  detectedAt: Date;
}
```

Create `packages/domain/src/artifact.ts`:
```ts
export type ArtifactType =
  | 'prompt'
  | 'stdout'
  | 'stderr'
  | 'combined_log'
  | 'issue'
  | 'design'
  | 'plan'
  | 'implementation_log'
  | 'validation'
  | 'review'
  | 'fix_log'
  | 'diff'
  | 'result'
  | 'summary'
  | 'pr'
  | 'comment'
  | 'reply'
  | 'run_metadata'
  | 'failure';

export interface Artifact {
  id: string;
  runUuid: string;
  phase?: string;
  type: ArtifactType;
  path: string;
  createdAt: Date;
}
```

Replace `packages/domain/src/index.ts`:
```ts
export const packageName = '@ai-sdlc/domain';
export * from './run.js';
export * from './phase.js';
export * from './failure.js';
export * from './artifact.js';
```

- [ ] **Step 3.8: Run domain tests — expect PASS**

```bash
pnpm --filter @ai-sdlc/domain test
```

- [ ] **Step 3.9: Add workspace dependencies for infrastructure**

Edit `packages/infrastructure/package.json` to include:
```json
"dependencies": {
  "@ai-sdlc/domain": "workspace:*",
  "@ai-sdlc/shared": "workspace:*"
}
```

Run `pnpm install` to link.

- [ ] **Step 3.10: Write failing test for `RunDirectory`**

Create `packages/infrastructure/src/__tests__/run-directory.test.ts`:
```ts
import { existsSync, readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunDirectory } from '../run-directory.js';

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'ai-orch-rd-'));
}

describe('RunDirectory', () => {
  it('creates the expected subdirectories', () => {
    const root = makeRoot();
    const dir = RunDirectory.create({
      rootDir: root,
      run: {
        uuid: 'u',
        displayId: 'issue-1-20260513-000000',
        issueNumber: 1,
        type: 'issue_to_pr',
        status: 'running',
        completedPhases: [],
        startedAt: new Date('2026-05-13T00:00:00Z'),
      },
    });
    expect(existsSync(dir.runRoot)).toBe(true);
    expect(existsSync(join(dir.runRoot, 'phases'))).toBe(true);
    expect(existsSync(join(dir.runRoot, 'artifacts'))).toBe(true);
    expect(existsSync(join(dir.runRoot, 'run.json'))).toBe(true);
  });

  it('writes run.json atomically and re-readable', () => {
    const root = makeRoot();
    const dir = RunDirectory.create({
      rootDir: root,
      run: {
        uuid: 'u',
        displayId: 'issue-2-20260513-000000',
        issueNumber: 2,
        type: 'issue_to_pr',
        status: 'running',
        completedPhases: [],
        startedAt: new Date('2026-05-13T00:00:00Z'),
      },
    });
    const parsed = JSON.parse(readFileSync(join(dir.runRoot, 'run.json'), 'utf8'));
    expect(parsed.displayId).toBe('issue-2-20260513-000000');
    expect(parsed.status).toBe('running');
  });
});
```

- [ ] **Step 3.11: Implement `RunDirectory`**

Create `packages/infrastructure/src/run-directory.ts`:
```ts
import { mkdirSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import type { Run } from '@ai-sdlc/domain';

export interface RunDirectoryPaths {
  runRoot: string;
  phasesDir: string;
  artifactsDir: string;
  runJsonPath: string;
  stdoutLogPath: string;
  stderrLogPath: string;
  combinedLogPath: string;
  failureJsonPath: string;
  eventsJsonlPath: string;
}

export class RunDirectory {
  private constructor(public readonly paths: RunDirectoryPaths) {}

  static paths(rootDir: string, displayId: string): RunDirectoryPaths {
    const runRoot = join(rootDir, displayId);
    return {
      runRoot,
      phasesDir: join(runRoot, 'phases'),
      artifactsDir: join(runRoot, 'artifacts'),
      runJsonPath: join(runRoot, 'run.json'),
      stdoutLogPath: join(runRoot, 'stdout.log'),
      stderrLogPath: join(runRoot, 'stderr.log'),
      combinedLogPath: join(runRoot, 'combined.log'),
      failureJsonPath: join(runRoot, 'failure.json'),
      eventsJsonlPath: join(runRoot, 'events.jsonl'),
    };
  }

  static create(input: { rootDir: string; run: Run }): RunDirectory {
    const paths = RunDirectory.paths(input.rootDir, input.run.displayId);
    mkdirSync(paths.runRoot, { recursive: true });
    mkdirSync(paths.phasesDir, { recursive: true });
    mkdirSync(paths.artifactsDir, { recursive: true });
    const dir = new RunDirectory(paths);
    dir.writeRunJson(input.run);
    return dir;
  }

  get runRoot(): string {
    return this.paths.runRoot;
  }

  writeRunJson(run: Run): void {
    atomicWriteJson(this.paths.runJsonPath, run);
  }
}

function atomicWriteJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  const fd = openSync(tmp, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}
```

- [ ] **Step 3.12: Export RunDirectory**

Replace `packages/infrastructure/src/index.ts`:
```ts
export const packageName = '@ai-sdlc/infrastructure';
export * from './run-directory.js';
```

- [ ] **Step 3.13: Run infrastructure tests — expect PASS**

```bash
pnpm --filter @ai-sdlc/infrastructure test
```

- [ ] **Step 3.14: Commit**

```bash
git add packages/shared packages/domain packages/infrastructure
git commit -m "feat(domain): add run identity, domain types, and run directory layout"
```

---

# Task 4 — SQLite repositories (story M1-04)

**Files:**
- Modify: `packages/infrastructure/package.json` (add `better-sqlite3`)
- Create: `packages/infrastructure/src/sqlite/database.ts`
- Create: `packages/infrastructure/src/sqlite/migrations.ts`
- Create: `packages/infrastructure/src/sqlite/migrations/0001-init.ts` (SQL inlined as a `const` so it survives `tsc` builds)
- Create: `packages/infrastructure/src/sqlite/run-repository.ts`
- Create: `packages/infrastructure/src/sqlite/phase-repository.ts`
- Create: `packages/infrastructure/src/sqlite/event-repository.ts`
- Create: `packages/infrastructure/src/sqlite/artifact-repository.ts`
- Create: `packages/infrastructure/src/sqlite/failure-repository.ts`
- Create: `packages/infrastructure/src/sqlite/__tests__/*.test.ts`
- Modify: `packages/infrastructure/src/index.ts`

- [ ] **Step 4.1: Add deps**

```bash
pnpm --filter @ai-sdlc/infrastructure add better-sqlite3@^11.5.0
pnpm --filter @ai-sdlc/infrastructure add -D @types/better-sqlite3@^7.6.11
```

- [ ] **Step 4.2: Author the migration SQL as a TypeScript module**

> **Why not a `.sql` file?** `tsc` only emits `.js`/`.d.ts`. A `.sql` file sitting next to `migrations.ts` is **not** copied into `dist/`, so the built CLI would `ENOENT` at startup. Inlining the SQL into a `.ts` constant means there is exactly one shipped artifact per migration. Trade-off: SQL editors don't syntax-highlight it. Acceptable.

Create `packages/infrastructure/src/sqlite/migrations/0001-init.ts`:
```ts
export const version = 1;
export const sql = /* sql */ `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  uuid TEXT PRIMARY KEY,
  display_id TEXT NOT NULL UNIQUE,
  issue_number INTEGER NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  current_phase TEXT,
  completed_phases TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  failure_reason TEXT,
  exit_code INTEGER,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_runs_issue_status ON runs (issue_number, status);
CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs (started_at DESC);

CREATE TABLE IF NOT EXISTS phases (
  id TEXT PRIMARY KEY,
  run_uuid TEXT NOT NULL REFERENCES runs(uuid) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_phases_run ON phases (run_uuid, name);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_uuid TEXT NOT NULL REFERENCES runs(uuid) ON DELETE CASCADE,
  phase TEXT,
  level TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_run_ts ON events (run_uuid, timestamp);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  run_uuid TEXT NOT NULL REFERENCES runs(uuid) ON DELETE CASCADE,
  phase TEXT,
  type TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts (run_uuid);

CREATE TABLE IF NOT EXISTS failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_uuid TEXT NOT NULL REFERENCES runs(uuid) ON DELETE CASCADE,
  phase TEXT,
  step TEXT,
  attempt INTEGER,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  exit_code INTEGER,
  can_retry INTEGER NOT NULL,
  suggested_action TEXT NOT NULL,
  artifacts TEXT NOT NULL DEFAULT '[]',
  detected_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_failures_run ON failures (run_uuid);
`;
```

- [ ] **Step 4.3: Implement `database.ts` and `migrations.ts`**

Create `packages/infrastructure/src/sqlite/database.ts`:
```ts
import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

export type Db = Database.Database;

export function openDatabase(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  return db;
}
```

Create `packages/infrastructure/src/sqlite/migrations.ts`:
```ts
import type { Db } from './database.js';
import * as init from './migrations/0001-init.js';

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  { version: init.version, sql: init.sql },
];

export function applyMigrations(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);
  const applied = new Set(
    db.prepare('SELECT version FROM schema_version').all().map((r: any) => r.version),
  );
  const apply = db.transaction((version: number, sql: string) => {
    db.exec(sql);
    db.prepare('INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      version,
      new Date().toISOString(),
    );
  });
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    apply(m.version, m.sql);
  }
}
```

- [ ] **Step 4.4: Write failing test for `RunRepository`**

Create `packages/infrastructure/src/sqlite/__tests__/run-repository.test.ts`:
```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, applyMigrations, RunRepository } from '../../index.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-db-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  applyMigrations(db);
  return db;
}

describe('RunRepository', () => {
  it('inserts and reads a run round-trip', () => {
    const db = freshDb();
    const repo = new RunRepository(db);
    repo.insert({
      uuid: 'u1',
      displayId: 'issue-1-20260513-000000',
      issueNumber: 1,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });
    const found = repo.findByUuid('u1');
    expect(found?.displayId).toBe('issue-1-20260513-000000');
    expect(found?.status).toBe('running');
  });

  it('lists runs ordered by startedAt desc', () => {
    const db = freshDb();
    const repo = new RunRepository(db);
    for (let i = 1; i <= 3; i++) {
      repo.insert({
        uuid: `u${i}`,
        displayId: `issue-${i}-20260513-00000${i}`,
        issueNumber: i,
        type: 'issue_to_pr',
        status: 'running',
        completedPhases: [],
        startedAt: new Date(`2026-05-13T00:00:0${i}Z`),
      });
    }
    const all = repo.list();
    expect(all.map((r) => r.uuid)).toEqual(['u3', 'u2', 'u1']);
  });

  it('updates status, exit code, duration', () => {
    const db = freshDb();
    const repo = new RunRepository(db);
    repo.insert({
      uuid: 'u',
      displayId: 'issue-1-20260513-000000',
      issueNumber: 1,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });
    repo.update('u', { status: 'failed', exitCode: 2, durationMs: 1500, failureReason: 'boom' });
    const got = repo.findByUuid('u');
    expect(got?.status).toBe('failed');
    expect(got?.exitCode).toBe(2);
    expect(got?.durationMs).toBe(1500);
  });

  it('refuses to create a second active run for the same issue', () => {
    const db = freshDb();
    const repo = new RunRepository(db);
    repo.insert({
      uuid: 'a',
      displayId: 'issue-1-20260513-000000',
      issueNumber: 1,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });
    expect(() =>
      repo.insertIfNoActive({
        uuid: 'b',
        displayId: 'issue-1-20260513-000001',
        issueNumber: 1,
        type: 'issue_to_pr',
        status: 'running',
        completedPhases: [],
        startedAt: new Date('2026-05-13T00:00:01Z'),
      }),
    ).toThrow(/active run/i);
  });
});
```

- [ ] **Step 4.5: Implement `run-repository.ts`**

Create `packages/infrastructure/src/sqlite/run-repository.ts`:
```ts
import type { Run, RunStatus } from '@ai-sdlc/domain';
import type { Db } from './database.js';

interface RunRow {
  uuid: string;
  display_id: string;
  issue_number: number;
  type: string;
  status: string;
  current_phase: string | null;
  completed_phases: string;
  started_at: string;
  completed_at: string | null;
  failure_reason: string | null;
  exit_code: number | null;
  duration_ms: number | null;
}

export interface RunRecord extends Run {
  exitCode?: number;
  durationMs?: number;
}

export class RunRepository {
  constructor(private readonly db: Db) {}

  insert(run: Run): void {
    this.db
      .prepare(
        `INSERT INTO runs (uuid, display_id, issue_number, type, status, current_phase,
          completed_phases, started_at, completed_at, failure_reason)
         VALUES (@uuid, @display_id, @issue_number, @type, @status, @current_phase,
          @completed_phases, @started_at, @completed_at, @failure_reason)`,
      )
      .run({
        uuid: run.uuid,
        display_id: run.displayId,
        issue_number: run.issueNumber,
        type: run.type,
        status: run.status,
        current_phase: run.currentPhase ?? null,
        completed_phases: JSON.stringify(run.completedPhases),
        started_at: run.startedAt.toISOString(),
        completed_at: run.completedAt?.toISOString() ?? null,
        failure_reason: run.failureReason ?? null,
      });
  }

  insertIfNoActive(run: Run): void {
    const tx = this.db.transaction((r: Run) => {
      const active = this.db
        .prepare(
          `SELECT 1 FROM runs WHERE issue_number = ? AND status IN ('queued','running','waiting','blocked')`,
        )
        .get(r.issueNumber);
      if (active) {
        throw new Error(`An active run already exists for issue ${r.issueNumber}`);
      }
      this.insert(r);
    });
    tx(run);
  }

  findByUuid(uuid: string): RunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE uuid = ?').get(uuid) as RunRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  list(): RunRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM runs ORDER BY started_at DESC')
      .all() as RunRow[];
    return rows.map(toRecord);
  }

  update(
    uuid: string,
    patch: Partial<{
      status: RunStatus;
      currentPhase: string | null;
      completedPhases: string[];
      completedAt: Date;
      failureReason: string;
      exitCode: number;
      durationMs: number;
    }>,
  ): void {
    const fields: string[] = [];
    const params: Record<string, unknown> = { uuid };
    if (patch.status !== undefined) {
      fields.push('status = @status');
      params.status = patch.status;
    }
    if (patch.currentPhase !== undefined) {
      fields.push('current_phase = @current_phase');
      params.current_phase = patch.currentPhase;
    }
    if (patch.completedPhases !== undefined) {
      fields.push('completed_phases = @completed_phases');
      params.completed_phases = JSON.stringify(patch.completedPhases);
    }
    if (patch.completedAt !== undefined) {
      fields.push('completed_at = @completed_at');
      params.completed_at = patch.completedAt.toISOString();
    }
    if (patch.failureReason !== undefined) {
      fields.push('failure_reason = @failure_reason');
      params.failure_reason = patch.failureReason;
    }
    if (patch.exitCode !== undefined) {
      fields.push('exit_code = @exit_code');
      params.exit_code = patch.exitCode;
    }
    if (patch.durationMs !== undefined) {
      fields.push('duration_ms = @duration_ms');
      params.duration_ms = patch.durationMs;
    }
    if (fields.length === 0) return;
    this.db.prepare(`UPDATE runs SET ${fields.join(', ')} WHERE uuid = @uuid`).run(params);
  }
}

function toRecord(row: RunRow): RunRecord {
  return {
    uuid: row.uuid,
    displayId: row.display_id,
    issueNumber: row.issue_number,
    type: row.type as Run['type'],
    status: row.status as RunStatus,
    currentPhase: row.current_phase ?? undefined,
    completedPhases: JSON.parse(row.completed_phases) as string[],
    startedAt: new Date(row.started_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    failureReason: row.failure_reason ?? undefined,
    exitCode: row.exit_code ?? undefined,
    durationMs: row.duration_ms ?? undefined,
  };
}
```

- [ ] **Step 4.6: Implement the four remaining repositories**

Create `packages/infrastructure/src/sqlite/phase-repository.ts`:
```ts
import type { Phase, PhaseStatus } from '@ai-sdlc/domain';
import type { Db } from './database.js';

interface PhaseRow {
  id: string;
  run_uuid: string;
  name: string;
  status: string;
  attempt: number;
  started_at: string | null;
  completed_at: string | null;
}

export class PhaseRepository {
  constructor(private readonly db: Db) {}

  upsert(phase: Phase): void {
    this.db
      .prepare(
        `INSERT INTO phases (id, run_uuid, name, status, attempt, started_at, completed_at)
         VALUES (@id, @run_uuid, @name, @status, @attempt, @started_at, @completed_at)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           attempt = excluded.attempt,
           started_at = excluded.started_at,
           completed_at = excluded.completed_at`,
      )
      .run({
        id: phase.id,
        run_uuid: phase.runUuid,
        name: phase.name,
        status: phase.status,
        attempt: phase.attempt,
        started_at: phase.startedAt?.toISOString() ?? null,
        completed_at: phase.completedAt?.toISOString() ?? null,
      });
  }

  listByRun(runUuid: string): Phase[] {
    const rows = this.db
      .prepare('SELECT * FROM phases WHERE run_uuid = ? ORDER BY started_at ASC')
      .all(runUuid) as PhaseRow[];
    return rows.map((r) => ({
      id: r.id,
      runUuid: r.run_uuid,
      name: r.name,
      status: r.status as PhaseStatus,
      attempt: r.attempt,
      startedAt: r.started_at ? new Date(r.started_at) : undefined,
      completedAt: r.completed_at ? new Date(r.completed_at) : undefined,
    }));
  }
}
```

Create `packages/infrastructure/src/sqlite/event-repository.ts`:
```ts
import type { Db } from './database.js';

export interface EventRow {
  id: number;
  runUuid: string;
  phase?: string;
  level: string;
  type: string;
  message: string;
  metadata: Record<string, unknown>;
  timestamp: Date;
}

export interface EventInput {
  runUuid: string;
  phase?: string;
  level: string;
  type: string;
  message: string;
  metadata?: Record<string, unknown>;
  timestamp: Date;
}

export class EventRepository {
  constructor(private readonly db: Db) {}

  insert(event: EventInput): number {
    const res = this.db
      .prepare(
        `INSERT INTO events (run_uuid, phase, level, type, message, metadata, timestamp)
         VALUES (@run_uuid, @phase, @level, @type, @message, @metadata, @timestamp)`,
      )
      .run({
        run_uuid: event.runUuid,
        phase: event.phase ?? null,
        level: event.level,
        type: event.type,
        message: event.message,
        metadata: JSON.stringify(event.metadata ?? {}),
        timestamp: event.timestamp.toISOString(),
      });
    return Number(res.lastInsertRowid);
  }

  listByRunSince(runUuid: string, sinceIso?: string): EventRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE run_uuid = ? AND timestamp > COALESCE(?, '') ORDER BY timestamp ASC`,
      )
      .all(runUuid, sinceIso ?? '') as Array<{
      id: number;
      run_uuid: string;
      phase: string | null;
      level: string;
      type: string;
      message: string;
      metadata: string;
      timestamp: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      runUuid: r.run_uuid,
      phase: r.phase ?? undefined,
      level: r.level,
      type: r.type,
      message: r.message,
      metadata: JSON.parse(r.metadata),
      timestamp: new Date(r.timestamp),
    }));
  }
}
```

Create `packages/infrastructure/src/sqlite/artifact-repository.ts`:
```ts
import type { Artifact } from '@ai-sdlc/domain';
import type { Db } from './database.js';

export class ArtifactRepository {
  constructor(private readonly db: Db) {}

  insert(artifact: Artifact): void {
    this.db
      .prepare(
        `INSERT INTO artifacts (id, run_uuid, phase, type, path, created_at)
         VALUES (@id, @run_uuid, @phase, @type, @path, @created_at)`,
      )
      .run({
        id: artifact.id,
        run_uuid: artifact.runUuid,
        phase: artifact.phase ?? null,
        type: artifact.type,
        path: artifact.path,
        created_at: artifact.createdAt.toISOString(),
      });
  }

  listByRun(runUuid: string): Artifact[] {
    return (
      this.db
        .prepare('SELECT * FROM artifacts WHERE run_uuid = ? ORDER BY created_at ASC')
        .all(runUuid) as Array<{
        id: string;
        run_uuid: string;
        phase: string | null;
        type: string;
        path: string;
        created_at: string;
      }>
    ).map((r) => ({
      id: r.id,
      runUuid: r.run_uuid,
      phase: r.phase ?? undefined,
      type: r.type as Artifact['type'],
      path: r.path,
      createdAt: new Date(r.created_at),
    }));
  }
}
```

Create `packages/infrastructure/src/sqlite/failure-repository.ts`:
```ts
import type { Failure } from '@ai-sdlc/domain';
import type { Db } from './database.js';

export class FailureRepository {
  constructor(private readonly db: Db) {}

  insert(failure: Failure): void {
    this.db
      .prepare(
        `INSERT INTO failures (run_uuid, phase, step, attempt, kind, message, exit_code,
          can_retry, suggested_action, artifacts, detected_at)
         VALUES (@run_uuid, @phase, @step, @attempt, @kind, @message, @exit_code,
          @can_retry, @suggested_action, @artifacts, @detected_at)`,
      )
      .run({
        run_uuid: failure.runUuid,
        phase: failure.phase ?? null,
        step: failure.step ?? null,
        attempt: failure.attempt ?? null,
        kind: failure.kind,
        message: failure.message,
        exit_code: failure.exitCode ?? null,
        can_retry: failure.canRetry ? 1 : 0,
        suggested_action: failure.suggestedAction,
        artifacts: JSON.stringify(failure.artifacts),
        detected_at: failure.detectedAt.toISOString(),
      });
  }

  findLatestByRun(runUuid: string): Failure | undefined {
    const row = this.db
      .prepare('SELECT * FROM failures WHERE run_uuid = ? ORDER BY id DESC LIMIT 1')
      .get(runUuid) as
      | {
          run_uuid: string;
          phase: string | null;
          step: string | null;
          attempt: number | null;
          kind: string;
          message: string;
          exit_code: number | null;
          can_retry: number;
          suggested_action: string;
          artifacts: string;
          detected_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      runUuid: row.run_uuid,
      phase: row.phase ?? undefined,
      step: row.step ?? undefined,
      attempt: row.attempt ?? undefined,
      kind: row.kind as Failure['kind'],
      message: row.message,
      exitCode: row.exit_code ?? undefined,
      canRetry: row.can_retry === 1,
      suggestedAction: row.suggested_action,
      artifacts: JSON.parse(row.artifacts) as string[],
      detectedAt: new Date(row.detected_at),
    };
  }
}
```

- [ ] **Step 4.7: Add a migrations regression test**

Create `packages/infrastructure/src/sqlite/__tests__/migrations.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, applyMigrations } from '../../index.js';

describe('migrations', () => {
  it('is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-orch-mig-'));
    const db = openDatabase(join(dir, 'db.sqlite'));
    applyMigrations(db);
    applyMigrations(db);
    const versions = db.prepare('SELECT version FROM schema_version').all();
    expect(versions).toHaveLength(1);
  });
});
```

- [ ] **Step 4.8: Re-export from infrastructure index**

Replace `packages/infrastructure/src/index.ts`:
```ts
export const packageName = '@ai-sdlc/infrastructure';
export * from './run-directory.js';
export * from './sqlite/database.js';
export * from './sqlite/migrations.js';
export * from './sqlite/run-repository.js';
export * from './sqlite/phase-repository.js';
export * from './sqlite/event-repository.js';
export * from './sqlite/artifact-repository.js';
export * from './sqlite/failure-repository.js';
```

- [ ] **Step 4.9: Add foreign-key cascade test**

The issue's acceptance criteria require that deleting a `runs` row cascades to dependent rows. Create `packages/infrastructure/src/sqlite/__tests__/cascade.test.ts`:

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  openDatabase,
  applyMigrations,
  RunRepository,
  PhaseRepository,
  EventRepository,
  ArtifactRepository,
  FailureRepository,
} from '../../index.js';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-cas-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  applyMigrations(db);
  return db;
}

describe('foreign-key cascade', () => {
  it('deletes dependent rows when the parent run is deleted', () => {
    const db = fresh();
    const runs = new RunRepository(db);
    const phases = new PhaseRepository(db);
    const events = new EventRepository(db);
    const artifacts = new ArtifactRepository(db);
    const failures = new FailureRepository(db);

    runs.insert({
      uuid: 'u',
      displayId: 'issue-1-20260513-000000',
      issueNumber: 1,
      type: 'issue_to_pr',
      status: 'failed',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });
    phases.upsert({ id: 'p', runUuid: 'u', name: 'read_issue', status: 'failed', attempt: 1 });
    events.insert({
      runUuid: 'u', level: 'info', type: 'phase.started', message: 'x',
      timestamp: new Date('2026-05-13T00:00:01Z'),
    });
    artifacts.insert({
      id: 'a', runUuid: 'u', type: 'combined_log', path: 'combined.log',
      createdAt: new Date('2026-05-13T00:00:01Z'),
    });
    failures.insert({
      runUuid: 'u', kind: 'unknown', message: 'boom', canRetry: false,
      suggestedAction: '-', artifacts: [], detectedAt: new Date(),
    });

    db.prepare('DELETE FROM runs WHERE uuid = ?').run('u');

    expect(phases.listByRun('u')).toHaveLength(0);
    expect(events.listByRunSince('u')).toHaveLength(0);
    expect(artifacts.listByRun('u')).toHaveLength(0);
    expect(failures.findLatestByRun('u')).toBeUndefined();
  });
});
```

- [ ] **Step 4.10: Run all infrastructure tests — expect PASS**

```bash
pnpm --filter @ai-sdlc/infrastructure test
```

Expected: every repo test plus the migrations test passes.

- [ ] **Step 4.11: Commit**

```bash
git add packages/infrastructure
git commit -m "feat(infra): add sqlite migrations and Run/Phase/Event/Artifact/Failure repositories"
```

---

# Task 5 — Bash wrapper CLI (story M1-05)

**Files:**
- Create: `packages/application/src/start-issue-run.ts`
- Create: `packages/application/src/__tests__/start-issue-run.test.ts`
- Modify: `packages/application/src/index.ts`
- Modify: `packages/application/package.json` (workspace deps + execa)
- Create: `packages/infrastructure/src/bash/run-bash-script.ts`
- Create: `packages/infrastructure/src/bash/__tests__/run-bash-script.test.ts`
- Modify: `packages/infrastructure/package.json` (add `execa`)
- Modify: `packages/infrastructure/src/index.ts`
- Create: `apps/api/src/cli.ts`
- Create: `apps/api/src/compose.ts`
- Modify: `apps/api/package.json` (commander, workspace deps, `bin` field)

- [ ] **Step 5.1: Add execa and commander**

```bash
pnpm --filter @ai-sdlc/infrastructure add execa@^9.5.1
pnpm --filter @ai-sdlc/api add commander@^12.1.0
```

Add workspace deps to `packages/application/package.json`:
```json
"dependencies": {
  "@ai-sdlc/domain": "workspace:*",
  "@ai-sdlc/infrastructure": "workspace:*",
  "@ai-sdlc/shared": "workspace:*"
}
```

Replace `apps/api/package.json` (the placeholder from M1-01) with:
```json
{
  "name": "@ai-sdlc/api",
  "private": true,
  "type": "module",
  "bin": { "orchestrator": "./src/cli.ts" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "dev": "node --import tsx/esm src/cli.ts",
    "start": "node --import tsx/esm src/cli.ts"
  },
  "dependencies": {
    "@ai-sdlc/application": "workspace:*",
    "@ai-sdlc/domain": "workspace:*",
    "@ai-sdlc/infrastructure": "workspace:*",
    "@ai-sdlc/shared": "workspace:*",
    "commander": "^12.1.0",
    "tsx": "^4.19.2"
  }
}
```

> **Why `bin` points at `src/cli.ts`, not `dist/cli.js`** — every workspace package's `main` resolves to its `src/index.ts`. After `tsc` build, `dist/cli.js` imports those `.ts` paths and Node refuses (`ERR_UNKNOWN_FILE_EXTENSION`). The simplest fix for M1 is to keep the runtime on `tsx`. We move to a bundled production binary (tsup) at M8 when the executor stabilises. `tsx` is therefore a **runtime** dependency, not just a dev dep.

The `cli.ts` file (created in Step 5.8 below) must include a shebang on line 1:

```
#!/usr/bin/env -S node --import tsx/esm
```

`tsc` build still runs (it produces `dist/` for consumers who want type declarations), but neither `start` nor `bin` invokes `dist/cli.js`.

Run `pnpm install`.

- [ ] **Step 5.2: Write failing test for `runBashScript`**

Create `packages/infrastructure/src/bash/__tests__/run-bash-script.test.ts`:
```ts
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runBashScript } from '../run-bash-script.js';

function makeScript(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-sh-'));
  const path = join(dir, 'fake.sh');
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ai-orch-out-'));
}

describe('runBashScript', () => {
  it('captures stdout, stderr, combined, exit code, duration', async () => {
    const out = tempDir();
    const script = makeScript('echo hello; echo oops 1>&2; exit 0');
    const res = await runBashScript({
      scriptPath: script,
      args: [],
      env: {},
      stdoutPath: join(out, 'stdout.log'),
      stderrPath: join(out, 'stderr.log'),
      combinedPath: join(out, 'combined.log'),
    });
    expect(res.exitCode).toBe(0);
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
    expect(readFileSync(join(out, 'stdout.log'), 'utf8')).toContain('hello');
    expect(readFileSync(join(out, 'stderr.log'), 'utf8')).toContain('oops');
    const combined = readFileSync(join(out, 'combined.log'), 'utf8');
    expect(combined).toContain('hello');
    expect(combined).toContain('oops');
  });

  it('returns a non-zero exit code when the script fails', async () => {
    const out = tempDir();
    const script = makeScript('echo bye 1>&2; exit 7');
    const res = await runBashScript({
      scriptPath: script,
      args: [],
      env: {},
      stdoutPath: join(out, 'stdout.log'),
      stderrPath: join(out, 'stderr.log'),
      combinedPath: join(out, 'combined.log'),
    });
    expect(res.exitCode).toBe(7);
  });
});
```

- [ ] **Step 5.3: Implement `runBashScript`**

Create `packages/infrastructure/src/bash/run-bash-script.ts`:
```ts
import { createWriteStream } from 'node:fs';
import { execa } from 'execa';

export interface RunBashScriptInput {
  scriptPath: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  stdoutPath: string;
  stderrPath: string;
  combinedPath: string;
}

export interface RunBashScriptResult {
  exitCode: number;
  durationMs: number;
}

export async function runBashScript(input: RunBashScriptInput): Promise<RunBashScriptResult> {
  const startedAt = Date.now();
  const stdoutFile = createWriteStream(input.stdoutPath);
  const stderrFile = createWriteStream(input.stderrPath);
  const combinedFile = createWriteStream(input.combinedPath);

  const child = execa(input.scriptPath, input.args, {
    cwd: input.cwd,
    env: { ...process.env, ...input.env },
    reject: false,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  child.stdout?.on('data', (chunk) => {
    stdoutFile.write(chunk);
    combinedFile.write(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderrFile.write(chunk);
    combinedFile.write(chunk);
  });

  const result = await child;

  await Promise.all([
    new Promise<void>((res) => stdoutFile.end(res)),
    new Promise<void>((res) => stderrFile.end(res)),
    new Promise<void>((res) => combinedFile.end(res)),
  ]);

  return {
    exitCode: result.exitCode ?? (result.signal ? 128 : 1),
    durationMs: Date.now() - startedAt,
  };
}
```

Append to `packages/infrastructure/src/index.ts`:
```ts
export * from './bash/run-bash-script.js';
```

- [ ] **Step 5.4: Run infrastructure tests — expect PASS**

```bash
pnpm --filter @ai-sdlc/infrastructure test
```

- [ ] **Step 5.5: Write failing test for `StartIssueRun`**

Create `packages/application/src/__tests__/start-issue-run.test.ts`:
```ts
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  openDatabase,
  applyMigrations,
  RunRepository,
  RunDirectory,
} from '@ai-sdlc/infrastructure';
import { StartIssueRun } from '../start-issue-run.js';

function fakeScript(exitCode: number, stdout = 'hello', stderr = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-fake-'));
  const path = join(dir, 'ai-run.sh');
  writeFileSync(
    path,
    `#!/usr/bin/env bash\necho '${stdout}'\n${stderr ? `echo '${stderr}' 1>&2\n` : ''}exit ${exitCode}\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

describe('StartIssueRun', () => {
  it('creates a run row, directory, logs, and updates status on success', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-orch-run-'));
    const db = openDatabase(join(root, 'orch.sqlite'));
    applyMigrations(db);
    const repo = new RunRepository(db);
    const usecase = new StartIssueRun({
      runRepository: repo,
      runsDir: join(root, '.ai-runs'),
      scriptPath: fakeScript(0, 'plan done'),
      now: () => new Date('2026-05-13T19:23:00Z'),
    });
    const out = await usecase.execute({ issueNumber: 42 });
    expect(out.displayId).toBe('issue-42-20260513-192300');

    const paths = RunDirectory.paths(join(root, '.ai-runs'), out.displayId);
    expect(existsSync(paths.runJsonPath)).toBe(true);
    expect(readFileSync(paths.stdoutLogPath, 'utf8')).toContain('plan done');

    const row = repo.findByUuid(out.uuid);
    expect(row?.status).toBe('passed');
    expect(row?.exitCode).toBe(0);
  });

  it('marks the run failed on non-zero exit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-orch-run-'));
    const db = openDatabase(join(root, 'orch.sqlite'));
    applyMigrations(db);
    const repo = new RunRepository(db);
    const usecase = new StartIssueRun({
      runRepository: repo,
      runsDir: join(root, '.ai-runs'),
      scriptPath: fakeScript(3),
      now: () => new Date('2026-05-13T19:23:00Z'),
    });
    const out = await usecase.execute({ issueNumber: 99 });
    const row = repo.findByUuid(out.uuid);
    expect(row?.status).toBe('failed');
    expect(row?.exitCode).toBe(3);
  });

  it('refuses to start a second active run for the same issue', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-orch-run-'));
    const db = openDatabase(join(root, 'orch.sqlite'));
    applyMigrations(db);
    const repo = new RunRepository(db);
    // Insert an active run directly.
    repo.insert({
      uuid: 'existing',
      displayId: 'issue-7-20260513-000000',
      issueNumber: 7,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });
    const usecase = new StartIssueRun({
      runRepository: repo,
      runsDir: join(root, '.ai-runs'),
      scriptPath: fakeScript(0),
      now: () => new Date('2026-05-13T19:23:00Z'),
    });
    await expect(usecase.execute({ issueNumber: 7 })).rejects.toThrow(/active run/i);
  });
});
```

- [ ] **Step 5.6: Implement `StartIssueRun`**

Create `packages/application/src/start-issue-run.ts`:
```ts
import { createRun, passRun, failRun } from '@ai-sdlc/domain';
import { newRunId } from '@ai-sdlc/shared';
import { RunDirectory, runBashScript, type RunRepository } from '@ai-sdlc/infrastructure';

export interface StartIssueRunDeps {
  runRepository: RunRepository;
  runsDir: string;
  scriptPath: string;
  baseBranch?: string;
  model?: string;
  agentCli?: string;
  now?: () => Date;
}

export interface StartIssueRunInput {
  issueNumber: number;
}

export interface StartIssueRunOutput {
  uuid: string;
  displayId: string;
  exitCode: number;
  status: 'passed' | 'failed';
}

export class StartIssueRun {
  constructor(private readonly deps: StartIssueRunDeps) {}

  async execute(input: StartIssueRunInput): Promise<StartIssueRunOutput> {
    const now = this.deps.now ?? (() => new Date());
    const startedAt = now();
    const ids = newRunId({ issueNumber: input.issueNumber, now: startedAt });
    const run = createRun({
      uuid: ids.uuid,
      displayId: ids.displayId,
      issueNumber: input.issueNumber,
      startedAt,
    });

    this.deps.runRepository.insertIfNoActive(run);
    const dir = RunDirectory.create({ rootDir: this.deps.runsDir, run });

    const env = {
      AI_RUN_UUID: run.uuid,
      AI_RUN_DISPLAY_ID: run.displayId,
      AI_RUN_DIR: dir.runRoot,
      AI_ISSUE_NUMBER: String(input.issueNumber),
      ...(this.deps.baseBranch ? { AI_BASE_BRANCH: this.deps.baseBranch } : {}),
      ...(this.deps.model ? { AI_MODEL: this.deps.model } : {}),
      ...(this.deps.agentCli ? { AI_RUNTIME: this.deps.agentCli } : {}),
    };

    const exec = await runBashScript({
      scriptPath: this.deps.scriptPath,
      args: [String(input.issueNumber)],
      env,
      stdoutPath: dir.paths.stdoutLogPath,
      stderrPath: dir.paths.stderrLogPath,
      combinedPath: dir.paths.combinedLogPath,
    });

    const completedAt = now();
    const finalStatus: 'passed' | 'failed' = exec.exitCode === 0 ? 'passed' : 'failed';
    this.deps.runRepository.update(run.uuid, {
      status: finalStatus,
      completedAt,
      exitCode: exec.exitCode,
      durationMs: exec.durationMs,
      failureReason: finalStatus === 'failed' ? `script exited with code ${exec.exitCode}` : undefined,
    });
    const finalRun =
      finalStatus === 'passed' ? passRun(run, completedAt) : failRun(run, `exit ${exec.exitCode}`, completedAt);
    dir.writeRunJson(finalRun);

    return { uuid: run.uuid, displayId: run.displayId, exitCode: exec.exitCode, status: finalStatus };
  }
}
```

Replace `packages/application/src/index.ts`:
```ts
export const packageName = '@ai-sdlc/application';
export * from './start-issue-run.js';
```

- [ ] **Step 5.7: Run application tests — expect PASS**

```bash
pnpm --filter @ai-sdlc/application test
```

- [ ] **Step 5.8: Implement composition root + CLI entry**

Create `apps/api/src/compose.ts`:
```ts
import { join } from 'node:path';
import {
  openDatabase,
  applyMigrations,
  RunRepository,
  PhaseRepository,
  EventRepository,
  ArtifactRepository,
  FailureRepository,
} from '@ai-sdlc/infrastructure';
import { StartIssueRun } from '@ai-sdlc/application';

export interface Container {
  runRepository: RunRepository;
  phaseRepository: PhaseRepository;
  eventRepository: EventRepository;
  artifactRepository: ArtifactRepository;
  failureRepository: FailureRepository;
  startIssueRun: StartIssueRun;
  runsDir: string;
}

export interface ComposeOptions {
  repoRoot: string;
  scriptPath: string;
}

export function composeRoot(opts: ComposeOptions): Container {
  const runsDir = join(opts.repoRoot, '.ai-runs');
  const db = openDatabase(join(runsDir, 'orchestrator.sqlite'));
  applyMigrations(db);
  const runRepository = new RunRepository(db);
  const phaseRepository = new PhaseRepository(db);
  const eventRepository = new EventRepository(db);
  const artifactRepository = new ArtifactRepository(db);
  const failureRepository = new FailureRepository(db);
  const startIssueRun = new StartIssueRun({
    runRepository,
    runsDir,
    scriptPath: opts.scriptPath,
  });
  return {
    runRepository,
    phaseRepository,
    eventRepository,
    artifactRepository,
    failureRepository,
    startIssueRun,
    runsDir,
  };
}
```

Create `apps/api/src/cli.ts`:
```ts
#!/usr/bin/env -S node --import tsx/esm
import { Command } from 'commander';
import { resolve } from 'node:path';
import { composeRoot } from './compose.js';

const program = new Command();

program
  .name('orchestrator')
  .description('AI SDLC Orchestrator CLI')
  .version('0.0.0');

program
  .command('run')
  .description('Start an issue-to-PR run by wrapping the legacy Bash script')
  .requiredOption('--issue <number>', 'GitHub issue number', (v) => parseInt(v, 10))
  .option('--base-branch <branch>', 'Base branch (defaults to main)', 'main')
  .option('--model <model>', 'AI_MODEL env var')
  .option('--agent-cli <cli>', 'AI_RUNTIME env var')
  .option(
    '--script <path>',
    'Path to Bash script to wrap',
    resolve(process.cwd(), 'scripts/ai-run-issue-v2'),
  )
  .action(async (opts) => {
    try {
      const c = composeRoot({ repoRoot: process.cwd(), scriptPath: opts.script });
      const out = await c.startIssueRun.execute({ issueNumber: opts.issue });
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(out));
      process.exit(out.status === 'passed' ? 0 : 1);
    } catch (err) {
      // Pre-flight errors (e.g. "active run already exists") exit 2 per the
      // M1-05 acceptance criteria. Anything else also lands here — that's
      // still a pre-flight class because the use case did not return a
      // structured outcome.
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
});
```

Exit codes — locked for M1:

| Code | Meaning |
| --- | --- |
| `0` | Run completed; `status === 'passed'`. |
| `1` | Run completed; `status === 'failed'` (non-zero exit from the wrapped Bash). |
| `2` | Pre-flight error (active run for the issue exists, config missing, IO failure before/around the run). |

- [ ] **Step 5.9: Verify the CLI builds and runs**

Build (produces declarations + `dist/`, no runtime impact):
```bash
pnpm --filter @ai-sdlc/api build
```

Dry-run via the `dev` script (which uses `tsx`, the same runtime as `bin`):
```bash
pnpm --filter @ai-sdlc/api dev run --issue 1 --script ./scripts/ai-run-issue-v2 || true
```

Expected: a `.ai-runs/issue-1-*` directory appears with `run.json`, `stdout.log`, `stderr.log`, `combined.log` (the legacy script may exit non-zero — that's fine for smoke). Confirm a row exists in `.ai-runs/orchestrator.sqlite` (use `sqlite3 .ai-runs/orchestrator.sqlite 'select * from runs;'`).

> **About `combined.log`:** stdout and stderr are interleaved opportunistically — the underlying `data` events fire independently and we tee both into the same file. Do **not** write tests that assert a specific interleaving order between the two streams. Assert presence of expected lines, not their relative position.

> **About concurrency:** `RunDirectory` is single-writer per run. Two `StartIssueRun.execute` calls for the same issue cannot happen because `RunRepository.insertIfNoActive` is the gate. Don't add file locks.

- [ ] **Step 5.10: Commit**

```bash
git add packages/application packages/infrastructure apps/api
git commit -m "feat(cli): add Bash wrapper StartIssueRun use case and orchestrator CLI"
```

---

# Task 6 — Failure classifier (story M1-06)

**Files:**
- Create: `packages/infrastructure/src/failure/classifier.ts`
- Create: `packages/infrastructure/src/failure/__tests__/classifier.test.ts`
- Modify: `packages/infrastructure/src/index.ts`
- Modify: `packages/application/src/start-issue-run.ts` (write failure.json, persist failure row)
- Modify: `packages/application/src/__tests__/start-issue-run.test.ts` (extend tests)

- [ ] **Step 6.1: Write failing test for `classifyExit`**

Create `packages/infrastructure/src/failure/__tests__/classifier.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { classifyExit } from '../classifier.js';

describe('classifyExit', () => {
  it('returns command_failed for exit 1 with no known sentinel', () => {
    const f = classifyExit({ exitCode: 1, combinedLogTail: 'something broke' });
    expect(f.kind).toBe('command_failed');
    expect(f.canRetry).toBe(false);
    expect(f.message).toContain('something broke');
  });

  it('recognizes missing artifact sentinel', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'orchestrator_fail: MISSING ARTIFACT design.md',
    });
    expect(f.kind).toBe('missing_artifact');
    expect(f.suggestedAction).toMatch(/inspect/i);
  });

  it('recognizes timeout sentinel', () => {
    const f = classifyExit({ exitCode: 124, combinedLogTail: 'TIMEOUT after 600s' });
    expect(f.kind).toBe('timeout');
  });

  it('recognizes branch_changed sentinel', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'check_branch_after_agent: branch changed from issue-1 to main',
    });
    expect(f.kind).toBe('branch_changed');
  });

  it('recognizes validation failure', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'validate phase failed: typecheck',
    });
    expect(f.kind).toBe('validation_failed');
  });

  it('classifies unknown when no sentinel matched and exit is non-zero', () => {
    const f = classifyExit({ exitCode: 137, combinedLogTail: 'killed' });
    expect(f.kind).toBe('unknown');
    expect(f.exitCode).toBe(137);
  });

  it('extracts the last phase mentioned from the log', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'starting phase plan-write\nplan-write done\nstarting phase implement\norchestrator_fail',
    });
    expect(f.phase).toBe('implement');
  });
});
```

- [ ] **Step 6.2: Implement classifier**

Create `packages/infrastructure/src/failure/classifier.ts`:
```ts
import type { Failure, FailureKind } from '@ai-sdlc/domain';

export interface ClassifyExitInput {
  exitCode: number;
  combinedLogTail: string;
  runUuid?: string;
  artifacts?: string[];
  detectedAt?: Date;
}

interface Pattern {
  kind: FailureKind;
  regex: RegExp;
  suggestedAction: string;
}

const PATTERNS: Pattern[] = [
  {
    kind: 'missing_artifact',
    regex: /MISSING ARTIFACT|required artifact .* not found/i,
    suggestedAction: 'Inspect the phase prompt and stdout; the agent did not produce the expected file.',
  },
  {
    kind: 'invalid_result',
    regex: /invalid result file|unexpected result value/i,
    suggestedAction: 'Inspect the agent result.json and prompt template.',
  },
  {
    kind: 'branch_changed',
    regex: /branch changed from/i,
    suggestedAction: 'Reset the worktree branch and retry; verify the agent prompt does not switch branches.',
  },
  {
    kind: 'timeout',
    regex: /timed? out|TIMEOUT/i,
    suggestedAction: 'Raise invocationMaxMinutes or investigate why the agent hung.',
  },
  {
    kind: 'validation_failed',
    regex: /validate phase failed|pnpm (test|lint|build|typecheck) failed/i,
    suggestedAction: 'Open the validate phase logs and rerun the failing command locally.',
  },
  {
    kind: 'github_failed',
    regex: /gh: api error|gh: HTTP \d{3}/i,
    suggestedAction: 'Check `gh auth status` and rate-limit headers.',
  },
  {
    kind: 'git_failed',
    regex: /fatal: .*git|git push failed/i,
    suggestedAction: 'Inspect the git state in the worktree.',
  },
  {
    kind: 'agent_blocked',
    regex: /agent reported BLOCKED/i,
    suggestedAction: 'The agent blocked itself — review the prompt and the reported reason.',
  },
];

const PHASE_REGEX = /(?:starting phase|PHASE=)\s*([a-z_-]+)/gi;

export function classifyExit(input: ClassifyExitInput): Omit<Failure, 'runUuid'> & { runUuid?: string } {
  const tail = input.combinedLogTail.slice(-8000);
  const phase = lastPhase(tail);

  for (const p of PATTERNS) {
    if (p.regex.test(tail)) {
      return {
        runUuid: input.runUuid,
        phase,
        kind: p.kind,
        message: firstMatch(tail, p.regex) ?? `Detected ${p.kind}`,
        exitCode: input.exitCode,
        canRetry: false,
        suggestedAction: p.suggestedAction,
        artifacts: input.artifacts ?? [],
        detectedAt: input.detectedAt ?? new Date(),
      };
    }
  }

  const kind: FailureKind = input.exitCode === 0 ? 'unknown' : input.exitCode === 1 ? 'command_failed' : 'unknown';
  return {
    runUuid: input.runUuid,
    phase,
    kind,
    message: tail.split('\n').slice(-3).join('\n').trim() || `Exited with code ${input.exitCode}`,
    exitCode: input.exitCode,
    canRetry: false,
    suggestedAction: 'Inspect combined.log and stderr.log for the cause.',
    artifacts: input.artifacts ?? [],
    detectedAt: input.detectedAt ?? new Date(),
  };
}

function lastPhase(tail: string): string | undefined {
  let m: RegExpExecArray | null;
  let last: string | undefined;
  while ((m = PHASE_REGEX.exec(tail))) last = m[1];
  PHASE_REGEX.lastIndex = 0;
  return last;
}

function firstMatch(text: string, regex: RegExp): string | undefined {
  const m = text.match(regex);
  return m ? m[0] : undefined;
}
```

Append to `packages/infrastructure/src/index.ts`:
```ts
export * from './failure/classifier.js';
```

- [ ] **Step 6.3: Run classifier tests — expect PASS**

```bash
pnpm --filter @ai-sdlc/infrastructure test
```

- [ ] **Step 6.4: Wire classifier into `StartIssueRun`**

Modify `packages/application/src/start-issue-run.ts`. Add `failureRepository` dep and write `failure.json` when the run fails:

Replace the file:
```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { createRun, passRun, failRun } from '@ai-sdlc/domain';
import { newRunId } from '@ai-sdlc/shared';
import {
  RunDirectory,
  runBashScript,
  classifyExit,
  type RunRepository,
  type FailureRepository,
} from '@ai-sdlc/infrastructure';

export interface StartIssueRunDeps {
  runRepository: RunRepository;
  failureRepository: FailureRepository;
  runsDir: string;
  scriptPath: string;
  baseBranch?: string;
  model?: string;
  agentCli?: string;
  now?: () => Date;
}

export interface StartIssueRunInput {
  issueNumber: number;
}

export interface StartIssueRunOutput {
  uuid: string;
  displayId: string;
  exitCode: number;
  status: 'passed' | 'failed';
}

export class StartIssueRun {
  constructor(private readonly deps: StartIssueRunDeps) {}

  async execute(input: StartIssueRunInput): Promise<StartIssueRunOutput> {
    const now = this.deps.now ?? (() => new Date());
    const startedAt = now();
    const ids = newRunId({ issueNumber: input.issueNumber, now: startedAt });
    const run = createRun({
      uuid: ids.uuid,
      displayId: ids.displayId,
      issueNumber: input.issueNumber,
      startedAt,
    });

    this.deps.runRepository.insertIfNoActive(run);
    const dir = RunDirectory.create({ rootDir: this.deps.runsDir, run });

    const env = {
      AI_RUN_UUID: run.uuid,
      AI_RUN_DISPLAY_ID: run.displayId,
      AI_RUN_DIR: dir.runRoot,
      AI_ISSUE_NUMBER: String(input.issueNumber),
      ...(this.deps.baseBranch ? { AI_BASE_BRANCH: this.deps.baseBranch } : {}),
      ...(this.deps.model ? { AI_MODEL: this.deps.model } : {}),
      ...(this.deps.agentCli ? { AI_RUNTIME: this.deps.agentCli } : {}),
    };

    const exec = await runBashScript({
      scriptPath: this.deps.scriptPath,
      args: [String(input.issueNumber)],
      env,
      stdoutPath: dir.paths.stdoutLogPath,
      stderrPath: dir.paths.stderrLogPath,
      combinedPath: dir.paths.combinedLogPath,
    });

    const completedAt = now();
    const finalStatus: 'passed' | 'failed' = exec.exitCode === 0 ? 'passed' : 'failed';

    if (finalStatus === 'failed') {
      const tail = safeRead(dir.paths.combinedLogPath);
      const classified = classifyExit({
        exitCode: exec.exitCode,
        combinedLogTail: tail,
        runUuid: run.uuid,
        artifacts: [
          dir.paths.stdoutLogPath,
          dir.paths.stderrLogPath,
          dir.paths.combinedLogPath,
        ],
        detectedAt: completedAt,
      });
      const failure = { ...classified, runUuid: run.uuid };
      writeFileSync(dir.paths.failureJsonPath, JSON.stringify(failure, null, 2));
      this.deps.failureRepository.insert(failure);
      this.deps.runRepository.update(run.uuid, {
        status: 'failed',
        completedAt,
        exitCode: exec.exitCode,
        durationMs: exec.durationMs,
        failureReason: failure.message,
      });
      dir.writeRunJson(failRun(run, failure.message, completedAt));
    } else {
      this.deps.runRepository.update(run.uuid, {
        status: 'passed',
        completedAt,
        exitCode: exec.exitCode,
        durationMs: exec.durationMs,
      });
      dir.writeRunJson(passRun(run, completedAt));
    }

    return { uuid: run.uuid, displayId: run.displayId, exitCode: exec.exitCode, status: finalStatus };
  }
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
```

- [ ] **Step 6.5: Extend `start-issue-run.test.ts` to check failure persistence**

Append the following to `packages/application/src/__tests__/start-issue-run.test.ts` and update the constructors to pass `failureRepository`:

```ts
import { FailureRepository } from '@ai-sdlc/infrastructure';
// inside the failing-exit test, replace the deps with:
const failureRepository = new FailureRepository(db);
const usecase = new StartIssueRun({
  runRepository: repo,
  failureRepository,
  runsDir: join(root, '.ai-runs'),
  scriptPath: fakeScript(1, '', 'MISSING ARTIFACT design.md'),
  now: () => new Date('2026-05-13T19:23:00Z'),
});
// after execute:
const failure = failureRepository.findLatestByRun(out.uuid);
expect(failure?.kind).toBe('missing_artifact');
const failureJson = readFileSync(
  join(root, '.ai-runs', out.displayId, 'failure.json'),
  'utf8',
);
expect(JSON.parse(failureJson).kind).toBe('missing_artifact');
```

Also update the other two tests to supply `failureRepository: new FailureRepository(db)`.

- [ ] **Step 6.6: Update `compose.ts` to inject the failure repo**

In `apps/api/src/compose.ts`, change the `StartIssueRun` construction to:
```ts
const startIssueRun = new StartIssueRun({
  runRepository,
  failureRepository,
  runsDir,
  scriptPath: opts.scriptPath,
});
```

- [ ] **Step 6.7: Run all tests — expect PASS**

```bash
pnpm -r typecheck
pnpm test
```

- [ ] **Step 6.8: Commit**

```bash
git add packages/infrastructure packages/application apps/api
git commit -m "feat(failure): classify Bash exit failures and persist failure.json"
```

---

# Task 7 — Web UI shell (story M1-07)

**Files:**
- Create: `apps/api/src/server.ts`
- Create: `apps/api/src/routes/runs.ts`
- Create: `apps/api/src/routes/artifacts.ts`
- Modify: `apps/api/src/cli.ts` (add `serve` command)
- Modify: `apps/api/package.json` (add Fastify + tsx)
- Create: `apps/web/*` (Next.js 15 + Tailwind + shadcn)
- Create: `apps/web/e2e/smoke.spec.ts`

- [ ] **Step 7.1: Add Fastify and test deps to api**

```bash
pnpm --filter @ai-sdlc/api add fastify@^5.1.0 @fastify/cors@^10.0.1
```

- [ ] **Step 7.2: Implement the runs route**

Create `apps/api/src/routes/runs.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import type { Container } from '../compose.js';

export async function runsRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get('/api/runs', async () => ({
    runs: c.runRepository.list().map(serializeRun),
  }));

  app.get<{ Params: { runId: string } }>('/api/runs/:runId', async (req, reply) => {
    const run = c.runRepository.findByUuid(req.params.runId);
    if (!run) return reply.code(404).send({ error: 'not_found' });
    const failure = c.failureRepository.findLatestByRun(req.params.runId);
    return { run: serializeRun(run), failure: failure ?? null };
  });
}

function serializeRun(r: ReturnType<Container['runRepository']['list']>[number]) {
  return {
    uuid: r.uuid,
    displayId: r.displayId,
    issueNumber: r.issueNumber,
    status: r.status,
    currentPhase: r.currentPhase ?? null,
    completedPhases: r.completedPhases,
    startedAt: r.startedAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
    exitCode: r.exitCode ?? null,
    durationMs: r.durationMs ?? null,
    failureReason: r.failureReason ?? null,
  };
}
```

- [ ] **Step 7.3: Implement the artifacts route (path-sanitised)**

Create `apps/api/src/routes/artifacts.ts`:
```ts
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, normalize, relative, isAbsolute } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Container } from '../compose.js';

interface FileEntry {
  path: string;
  size: number;
  modifiedAt: string;
}

function walk(root: string, prefix = ''): FileEntry[] {
  const out: FileEntry[] = [];
  for (const name of readdirSync(root)) {
    const abs = join(root, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      out.push(...walk(abs, rel));
    } else {
      out.push({ path: rel, size: stat.size, modifiedAt: stat.mtime.toISOString() });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export async function artifactsRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get<{ Params: { runId: string } }>(
    '/api/runs/:runId/artifacts',
    async (req, reply) => {
      const run = c.runRepository.findByUuid(req.params.runId);
      if (!run) return reply.code(404).send({ error: 'not_found' });
      const root = join(c.runsDir, run.displayId);
      return { files: walk(root) };
    },
  );

  app.get<{ Params: { runId: string; '*': string } }>(
    '/api/runs/:runId/artifacts/*',
    async (req, reply) => {
      const run = c.runRepository.findByUuid(req.params.runId);
      if (!run) return reply.code(404).send({ error: 'not_found' });
      const root = join(c.runsDir, run.displayId);
      const requested = normalize(req.params['*']);
      if (requested.startsWith('..') || isAbsolute(requested)) {
        return reply.code(400).send({ error: 'invalid_path' });
      }
      const abs = join(root, requested);
      if (relative(root, abs).startsWith('..')) {
        return reply.code(400).send({ error: 'invalid_path' });
      }
      try {
        const buf = readFileSync(abs);
        reply.header('content-type', guessType(abs));
        return reply.send(buf);
      } catch {
        return reply.code(404).send({ error: 'not_found' });
      }
    },
  );
}

function guessType(path: string): string {
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.md')) return 'text/markdown';
  if (path.endsWith('.log') || path.endsWith('.txt') || path.endsWith('.diff')) return 'text/plain';
  return 'application/octet-stream';
}
```

- [ ] **Step 7.4: Wire the Fastify server**

Create `apps/api/src/server.ts`:
```ts
import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { Container } from './compose.js';
import { runsRoutes } from './routes/runs.js';
import { artifactsRoutes } from './routes/artifacts.js';

export interface ServerOptions {
  container: Container;
  port?: number;
}

export async function startServer(opts: ServerOptions): Promise<{ stop: () => Promise<void> }> {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await runsRoutes(app, opts.container);
  await artifactsRoutes(app, opts.container);
  await app.listen({ port: opts.port ?? 4319, host: '127.0.0.1' });
  return {
    stop: async () => {
      await app.close();
    },
  };
}
```

Update `apps/api/src/cli.ts` to add a `serve` command:
```ts
program
  .command('serve')
  .description('Start the orchestrator HTTP API')
  .option('--port <port>', 'Port to listen on', (v) => parseInt(v, 10), 4319)
  .option(
    '--script <path>',
    'Path to Bash script to wrap',
    resolve(process.cwd(), 'scripts/ai-run-issue-v2'),
  )
  .action(async (opts) => {
    const c = composeRoot({ repoRoot: process.cwd(), scriptPath: opts.script });
    const { startServer } = await import('./server.js');
    await startServer({ container: c, port: opts.port });
  });
```

Add the missing `import` for `startServer` to keep types right — Commander's `.action` callback is async and the dynamic import is fine.

- [ ] **Step 7.5: Add an API integration test**

Create `apps/api/src/__tests__/routes.test.ts`. Each test allocates its own port to avoid collisions; the helper boots a server against a fresh temp repo.

```ts
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeRoot, type Container } from '../compose.js';
import { startServer } from '../server.js';

let nextPort = 4400;

async function bootServer(opts: { withRun?: boolean } = {}): Promise<{
  baseUrl: string;
  container: Container;
  stop: () => Promise<void>;
}> {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ai-orch-api-'));
  const scriptPath = join(repoRoot, 'fake.sh');
  writeFileSync(scriptPath, '#!/usr/bin/env bash\necho ok\nexit 0\n');
  chmodSync(scriptPath, 0o755);
  const container = composeRoot({ repoRoot, scriptPath });
  if (opts.withRun) await container.startIssueRun.execute({ issueNumber: 1 });
  const port = nextPort++;
  const server = await startServer({ container, port });
  return { baseUrl: `http://127.0.0.1:${port}`, container, stop: server.stop };
}

const stoppers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (stoppers.length) await stoppers.pop()!();
});

describe('routes', () => {
  it('lists runs', async () => {
    const { baseUrl, stop } = await bootServer({ withRun: true });
    stoppers.push(stop);
    const r = await fetch(`${baseUrl}/api/runs`);
    const body = (await r.json()) as { runs: Array<{ issueNumber: number }> };
    expect(body.runs.length).toBe(1);
    expect(body.runs[0]!.issueNumber).toBe(1);
  });

  it('returns 404 for an unknown run id', async () => {
    const { baseUrl, stop } = await bootServer();
    stoppers.push(stop);
    const r = await fetch(`${baseUrl}/api/runs/does-not-exist`);
    expect(r.status).toBe(404);
  });

  it('returns 400 when the artifact path tries to escape the run directory', async () => {
    const { baseUrl, container, stop } = await bootServer({ withRun: true });
    stoppers.push(stop);
    const run = container.runRepository.list()[0]!;
    const r = await fetch(`${baseUrl}/api/runs/${run.uuid}/artifacts/../../etc/passwd`);
    expect(r.status).toBe(400);
  });

  it('serves combined.log as text/plain', async () => {
    const { baseUrl, container, stop } = await bootServer({ withRun: true });
    stoppers.push(stop);
    const run = container.runRepository.list()[0]!;
    const r = await fetch(`${baseUrl}/api/runs/${run.uuid}/artifacts/combined.log`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/plain/);
    expect(await r.text()).toContain('ok');
  });
});
```

> **Why per-test ports** — Fastify holds the port until `stop()` resolves. Reusing the same port across tests in one file is racy when tests run in parallel. A monotonic counter keeps each test on its own port without `port: 0`'s extra plumbing.

- [ ] **Step 7.6: Run api tests — expect PASS**

```bash
pnpm --filter @ai-sdlc/api test
```

- [ ] **Step 7.7: Scaffold Next.js app**

Inside `apps/web`:

Create `apps/web/package.json`:
```json
{
  "name": "@ai-sdlc/web",
  "private": true,
  "version": "0.0.0",
  "scripts": {
    "dev": "next dev --port 4310",
    "build": "next build",
    "start": "next start --port 4310",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "e2e": "playwright test"
  },
  "dependencies": {
    "next": "^15.0.3",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "class-variance-authority": "^0.7.0",
    "clsx": "^2.1.1",
    "tailwind-merge": "^2.5.4",
    "@radix-ui/react-tabs": "^1.1.1"
  },
  "devDependencies": {
    "@playwright/test": "^1.48.2",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.14",
    "typescript": "^5.6.3"
  }
}
```

> Note: shadcn/ui is a copy-in component library. For this plan, copy the minimal primitives (button, card, table, tabs) directly into `src/components/ui/` instead of running the CLI.

Run `pnpm install`.

Create `apps/web/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "preserve",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["DOM", "DOM.Iterable", "ES2022"],
    "allowJs": true,
    "noEmit": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "src/**/*", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

Create `apps/web/next-env.d.ts` (Next.js regenerates this on every `next dev`/`build`, but we commit it so `pnpm -r typecheck` passes on a fresh clone before anyone has run Next):
```ts
/// <reference types="next" />
/// <reference types="next/image-types/global" />

// NOTE: This file should not be edited.
// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.
```

Create `apps/web/next.config.mjs`:
```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [{ source: '/api/:path*', destination: 'http://127.0.0.1:4319/api/:path*' }];
  },
};
export default nextConfig;
```

Create `apps/web/postcss.config.mjs`:
```js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

Create `apps/web/tailwind.config.ts`:
```ts
import type { Config } from 'tailwindcss';
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
};
export default config;
```

Create `apps/web/src/app/globals.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

Create `apps/web/src/app/layout.tsx`:
```tsx
import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'AI SDLC Orchestrator' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-50 text-slate-900 min-h-screen">{children}</body>
    </html>
  );
}
```

Create `apps/web/src/lib/api-client.ts`:
```ts
export interface RunDto {
  uuid: string;
  displayId: string;
  issueNumber: number;
  status: string;
  currentPhase: string | null;
  completedPhases: string[];
  startedAt: string;
  completedAt: string | null;
  exitCode: number | null;
  durationMs: number | null;
  failureReason: string | null;
}

export interface FailureDto {
  kind: string;
  message: string;
  phase?: string;
  exitCode?: number;
  suggestedAction: string;
  artifacts: string[];
}

export async function listRuns(): Promise<RunDto[]> {
  const r = await fetch('/api/runs', { cache: 'no-store' });
  if (!r.ok) throw new Error(`failed to load runs: ${r.status}`);
  return (await r.json()).runs as RunDto[];
}

export async function getRun(uuid: string): Promise<{ run: RunDto; failure: FailureDto | null }> {
  const r = await fetch(`/api/runs/${uuid}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`failed to load run: ${r.status}`);
  return r.json();
}

export interface ArtifactFile {
  path: string;
  size: number;
  modifiedAt: string;
}

export async function listArtifacts(uuid: string): Promise<ArtifactFile[]> {
  const r = await fetch(`/api/runs/${uuid}/artifacts`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`failed to load artifacts: ${r.status}`);
  return (await r.json()).files as ArtifactFile[];
}

export async function getArtifact(uuid: string, path: string): Promise<string> {
  const r = await fetch(`/api/runs/${uuid}/artifacts/${path}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`failed to load artifact: ${r.status}`);
  return r.text();
}
```

Create `apps/web/src/lib/format.ts`:
```ts
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}
```

Create `apps/web/src/app/page.tsx`:
```tsx
import Link from 'next/link';
import { listRuns } from '@/lib/api-client';
import { formatDuration } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const runs = await listRuns();
  return (
    <main className="mx-auto max-w-5xl p-6">
      <h1 className="text-2xl font-semibold mb-4">Runs</h1>
      <div className="overflow-x-auto rounded border bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="text-left px-3 py-2">Display ID</th>
              <th className="text-left px-3 py-2">Issue</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-left px-3 py-2">Phase</th>
              <th className="text-left px-3 py-2">Started</th>
              <th className="text-left px-3 py-2">Duration</th>
              <th className="text-left px-3 py-2">Failure</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.uuid} className="border-t">
                <td className="px-3 py-2 font-mono">
                  <Link className="text-blue-600 underline" href={`/runs/${r.uuid}`}>
                    {r.displayId}
                  </Link>
                </td>
                <td className="px-3 py-2">#{r.issueNumber}</td>
                <td className="px-3 py-2">{r.status}</td>
                <td className="px-3 py-2">{r.currentPhase ?? '—'}</td>
                <td className="px-3 py-2">{new Date(r.startedAt).toLocaleString()}</td>
                <td className="px-3 py-2">{formatDuration(r.durationMs)}</td>
                <td className="px-3 py-2 text-red-700">{r.failureReason ?? ''}</td>
              </tr>
            ))}
            {runs.length === 0 && (
              <tr>
                <td className="px-3 py-4 text-slate-500" colSpan={7}>
                  No runs yet. Start one with <code>orchestrator run --issue &lt;N&gt;</code>.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
```

Create `apps/web/src/app/runs/[id]/page.tsx`:
```tsx
import { notFound } from 'next/navigation';
import { getRun, listArtifacts, getArtifact } from '@/lib/api-client';
import { formatDuration } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function RunPage({ params }: { params: { id: string } }) {
  const { run, failure } = await getRun(params.id).catch(() => ({ run: null, failure: null } as any));
  if (!run) notFound();
  const files = await listArtifacts(params.id);
  const combined = files.find((f) => f.path === 'combined.log');
  const combinedContent = combined ? await getArtifact(params.id, 'combined.log') : '';

  return (
    <main className="mx-auto max-w-5xl p-6 space-y-6">
      <header className="flex flex-wrap gap-4 items-baseline">
        <h1 className="text-2xl font-semibold font-mono">{run.displayId}</h1>
        <span className="text-sm rounded bg-slate-200 px-2 py-0.5">{run.status}</span>
        <span className="text-sm text-slate-600">Issue #{run.issueNumber}</span>
        <span className="text-sm text-slate-600">{formatDuration(run.durationMs)}</span>
      </header>

      <section>
        <h2 className="font-semibold mb-2">Logs</h2>
        <pre className="rounded border bg-black text-green-200 p-3 overflow-auto max-h-[480px] text-xs">
          {combinedContent || '(no combined.log)'}
        </pre>
      </section>

      <section>
        <h2 className="font-semibold mb-2">Artifacts</h2>
        <ul className="text-sm space-y-1">
          {files.map((f) => (
            <li key={f.path}>
              <a className="text-blue-600 underline" href={`/api/runs/${run.uuid}/artifacts/${f.path}`}>
                {f.path}
              </a>
              <span className="ml-2 text-slate-500">{f.size} B</span>
            </li>
          ))}
        </ul>
      </section>

      {failure && (
        <section>
          <h2 className="font-semibold mb-2 text-red-700">Failure</h2>
          <div className="rounded border bg-red-50 p-3 text-sm space-y-1">
            <div><b>Kind:</b> {failure.kind}</div>
            {failure.phase && <div><b>Phase:</b> {failure.phase}</div>}
            {failure.exitCode !== undefined && <div><b>Exit code:</b> {failure.exitCode}</div>}
            <div><b>Message:</b> <pre className="inline whitespace-pre-wrap">{failure.message}</pre></div>
            <div><b>Suggested action:</b> {failure.suggestedAction}</div>
          </div>
        </section>
      )}
    </main>
  );
}
```

- [ ] **Step 7.8: Playwright smoke test**

Create `apps/web/playwright.config.ts`:
```ts
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:4310' },
});
```

Create `apps/web/e2e/smoke.spec.ts`:
```ts
import { test, expect } from '@playwright/test';

test('renders empty run list when no runs exist', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();
  await expect(page.getByText('No runs yet')).toBeVisible();
});
```

> The Playwright test is opt-in: it requires the API + Web servers to be running locally. CI does not run it in M1; the spec is parked for manual verification.

- [ ] **Step 7.9: Manual UI verification**

In separate terminals:
```bash
pnpm --filter @ai-sdlc/api dev serve
pnpm --filter @ai-sdlc/web dev
```

Visit `http://127.0.0.1:4310/` — expect "No runs yet". Trigger a run:
```bash
pnpm --filter @ai-sdlc/api dev run --issue 1 --script ./scripts/ai-run-issue-v2 || true
```

Refresh: a row appears. Click it: combined log and artifact list render. If the run failed, a red "Failure" panel renders below.

- [ ] **Step 7.10: Commit**

```bash
git add apps/api apps/web
git commit -m "feat(ui): Fastify API and Next.js dashboard with run list, detail, logs, artifacts, failure panel"
```

---

# Task 8 — Documentation pass (story M1-08)

**Files:**
- Modify: `README.md` (add Quickstart + config reference)
- Create: `docs/quickstart.md`

- [ ] **Step 8.1: Write Quickstart**

Create `docs/quickstart.md`:
```markdown
# Orchestrator Quickstart (M1)

## Prerequisites

- Node 22+
- pnpm 9+
- A repository with the legacy `scripts/ai-run-issue-v2` script and a valid `.ai-orchestrator.json`.
- `gh` CLI authenticated (needed by the legacy script).

## Install

```bash
corepack enable && pnpm install
```

## Start the API and UI

In two terminals:

```bash
pnpm --filter @ai-sdlc/api dev serve     # http://127.0.0.1:4319
pnpm --filter @ai-sdlc/web dev           # http://127.0.0.1:4310
```

## Start a run

```bash
pnpm --filter @ai-sdlc/api dev run --issue 123
```

Output:

```json
{
  "uuid": "…",
  "displayId": "issue-123-20260513-192300",
  "exitCode": 0,
  "status": "passed"
}
```

## Where things live

- Run metadata: `.ai-runs/<displayId>/run.json`
- Logs: `.ai-runs/<displayId>/{stdout,stderr,combined}.log`
- Failures: `.ai-runs/<displayId>/failure.json`
- Database: `.ai-runs/orchestrator.sqlite`

## Configuration

`.ai-orchestrator.json` at the repo root drives validation commands, skip-list, and timeouts. See `packages/shared/src/config/schema.ts` for the schema.
```

- [ ] **Step 8.2: Update README**

Replace the `## Current next step` section of `README.md` with **both** of the following sections (Quickstart and Repository layout — both are required by M1-08's acceptance criteria):

````markdown
## Quickstart

See [`docs/quickstart.md`](./docs/quickstart.md) for installation, starting the API/UI, and triggering a run via the `orchestrator` CLI.

## Repository layout

```text
apps/
  api/             Fastify HTTP API + `orchestrator` CLI
  web/             Next.js dashboard (run list, run detail, logs, artifacts)
packages/
  shared/          config schema, run identity, event schemas
  domain/          pure types: Run, Phase, Failure, Artifact
  application/     use cases (StartIssueRun)
  infrastructure/  SQLite repositories, RunDirectory, Bash wrapper, failure classifier
scripts/
  ai-run-issue-v2     legacy Bash orchestrator (still authoritative in M1)
  ai-pr-review-poll   legacy PR review poller
```
````

Note the **four** backticks on the outer fence — the inner ```` ```text ```` block needs to nest cleanly.

- [ ] **Step 8.3: Commit**

```bash
git add README.md docs/quickstart.md
git commit -m "docs: add M1 quickstart and link from README"
```

---

# Final verification

- [ ] **Run the full pipeline**

```bash
pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm lint
pnpm test
pnpm -r build
```

All five must exit 0.

- [ ] **Smoke the CLI against the real legacy script**

```bash
pnpm --filter @ai-sdlc/api dev run --issue <real_issue_number> --script ./scripts/ai-run-issue-v2
```

The run may succeed or fail — what matters is:
- A `.ai-runs/issue-<N>-*` directory exists with `run.json`, `stdout.log`, `stderr.log`, `combined.log`.
- A row exists in `orchestrator.sqlite`'s `runs` table.
- If the run failed, `failure.json` exists and a row exists in `failures`.
- The UI at `/runs/<uuid>` renders the run.

- [ ] **Open a PR**

```bash
git push -u origin <branch>
gh pr create --fill
```

PR description must list which stories (M1-01 … M1-08) are covered.

---

## Self-review checklist (run before declaring done)

- Spec coverage — each story M1-01..M1-08 maps to Tasks 1..8 respectively.
- No placeholders — every code block contains real code, every command shows expected output.
- Type consistency — `Run`, `Phase`, `Failure`, `Artifact` shapes are the same in `packages/domain`, the SQLite row mappers, the API serializers, and the React DTO.
- Acceptance per story:
  - M1-01: CI green, smoke tests pass. ✓ (Task 1 step 1.8/1.10)
  - M1-02: valid/invalid/missing config tests. ✓ (Task 2)
  - M1-03: run directory structure + atomic run.json + concurrent guard. ✓ (Tasks 3 + 4 — concurrency lives in `RunRepository.insertIfNoActive`)
  - M1-04: round-trip + idempotent migrations. ✓ (Task 4)
  - M1-05: end-to-end Bash wrapper produces run.json/logs/DB row. ✓ (Task 5)
  - M1-06: failure.json + classifier. ✓ (Task 6)
  - M1-07: run list + run detail + logs + artifacts + failure panel. ✓ (Task 7)
  - M1-08: README + quickstart docs. ✓ (Task 8)
