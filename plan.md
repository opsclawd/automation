# M1-01 — Bootstrap monorepo + tooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up an empty TypeScript/Node monorepo with pnpm workspaces, strict TypeScript config, Vitest, ESLint 9 flat config, and GitHub Actions CI — no application code.

**Architecture:** pnpm 9 workspaces with `apps/*` + `packages/*` layout. Each package/app has its own `tsconfig.json` extending a root `tsconfig.base.json`. Vitest configured at root level. ESLint 9 flat config with `@typescript-eslint`.

**Tech Stack:** pnpm 9.12.3, Node 22, TypeScript 5.6, Vitest 2, ESLint 9, Prettier 3

---

## Goal

Bootstrap a working monorepo shell where a fresh clone can run `pnpm install && pnpm -r typecheck && pnpm lint && pnpm test` with green output and no application code.

## Non-Goals

- Feature code (domain types, repositories, route handlers, React components)
- Husky / lint-staged / commitlint
- Turborepo / Nx
- `apps/web` Next.js scaffolding (deferred to Task 7)
- SQLite or any persistence layer
- Config loaders (deferred to M1-02)

---

## Affected Files

All paths are relative to repo root (`/`).

### Root config files (create)
- `package.json`
- `pnpm-workspace.yaml`
- `tsconfig.base.json`
- `vitest.config.ts`
- `eslint.config.mjs`
- `.prettierrc.json`
- `.editorconfig`
- `.nvmrc`

### Root config files (modify)
- `.gitignore` — append new entries

### GitHub Actions (create)
- `.github/workflows/ci.yml`

### Packages (create all)
- `packages/shared/package.json`
- `packages/shared/tsconfig.json`
- `packages/shared/src/index.ts`
- `packages/shared/src/__tests__/smoke.test.ts`

- `packages/domain/package.json`
- `packages/domain/tsconfig.json`
- `packages/domain/src/index.ts`
- `packages/domain/src/__tests__/smoke.test.ts`

- `packages/application/package.json`
- `packages/application/tsconfig.json`
- `packages/application/src/index.ts`
- `packages/application/src/__tests__/smoke.test.ts`

- `packages/infrastructure/package.json`
- `packages/infrastructure/tsconfig.json`
- `packages/infrastructure/src/index.ts`
- `packages/infrastructure/src/__tests__/smoke.test.ts`

### Apps (create all)
- `apps/api/package.json`
- `apps/api/tsconfig.json`
- `apps/api/src/index.ts`
- `apps/api/src/__tests__/smoke.test.ts`

- `apps/web/package.json` (placeholder only)

---

## Ordered Implementation Tasks

### Task 1: Create root workspace files

**Files:**
- Create: `package.json` (private, `"type": "module"`, `packageManager: "pnpm@9.12.3"`, devDeps: typescript, vitest, eslint, prettier, @typescript-eslint/*)
- Create: `pnpm-workspace.yaml` (`packages: ["apps/*", "packages/*"]`)
- Create: `tsconfig.base.json` (strict mode, exactOptionalPropertyTypes, noUncheckedIndexedAccess, noImplicitOverride, noFallthroughCasesInSwitch, moduleResolution: Bundler)
- Create: `.nvmrc` containing `22`
- Create: `.editorconfig` (2-space indent, lf, utf-8)
- Modify: `.gitignore` — append: `node_modules`, `dist`, `.next`, `coverage`, `*.tsbuildinfo`, `.ai-runs/`, `.ai-worktrees/`, `.DS_Store`

- [ ] **Step 1.1: Create `.nvmrc`**

```text
22
```

- [ ] **Step 1.2: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 1.3: Create `.editorconfig`**

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

- [ ] **Step 1.4: Append to `.gitignore`**

```text
node_modules
dist
.next
coverage
*.tsbuildinfo
.ai-runs/
.ai-worktrees/
.DS_Store
```

- [ ] **Step 1.5: Create `package.json`**

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

- [ ] **Step 1.6: Create `tsconfig.base.json`**

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

- [ ] **Step 1.7: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .nvmrc .editorconfig .gitignore
git commit -m "chore: add root workspace config files"
```

---

### Task 2: Create root lint/test config files

**Files:**
- Create: `eslint.config.mjs`
- Create: `.prettierrc.json`
- Create: `vitest.config.ts`

- [ ] **Step 2.1: Create `.prettierrc.json`**

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "arrowParens": "always"
}
```

- [ ] **Step 2.2: Create `eslint.config.mjs`**

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

- [ ] **Step 2.3: Create `vitest.config.ts`**

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

- [ ] **Step 2.4: Commit**

```bash
git add eslint.config.mjs .prettierrc.json vitest.config.ts
git commit -m "chore: add eslint, prettier, vitest root config"
```

---

### Task 3: Scaffold `packages/shared`

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/src/__tests__/smoke.test.ts`

- [ ] **Step 3.1: Create `packages/shared/package.json`**

```json
{
  "name": "@ai-sdlc/shared",
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

- [ ] **Step 3.2: Create `packages/shared/tsconfig.json`**

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

- [ ] **Step 3.3: Create `packages/shared/src/index.ts`**

```ts
export const packageName = '@ai-sdlc/shared';
```

- [ ] **Step 3.4: Create `packages/shared/src/__tests__/smoke.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { packageName } from '../index.js';

describe('@ai-sdlc/shared', () => {
  it('exports a package name', () => {
    expect(packageName).toBe('@ai-sdlc/shared');
  });
});
```

- [ ] **Step 3.5: Commit**

```bash
git add packages/shared/
git commit -m "chore: scaffold @ai-sdlc/shared package"
```

---

### Task 4: Scaffold `packages/domain`

**Files:**
- Create: `packages/domain/package.json`
- Create: `packages/domain/tsconfig.json`
- Create: `packages/domain/src/index.ts`
- Create: `packages/domain/src/__tests__/smoke.test.ts`

- [ ] **Step 4.1: Create `packages/domain/package.json`**

```json
{
  "name": "@ai-sdlc/domain",
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

- [ ] **Step 4.2: Create `packages/domain/tsconfig.json`**

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

- [ ] **Step 4.3: Create `packages/domain/src/index.ts`**

```ts
export const packageName = '@ai-sdlc/domain';
```

- [ ] **Step 4.4: Create `packages/domain/src/__tests__/smoke.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { packageName } from '../index.js';

describe('@ai-sdlc/domain', () => {
  it('exports a package name', () => {
    expect(packageName).toBe('@ai-sdlc/domain');
  });
});
```

- [ ] **Step 4.5: Commit**

```bash
git add packages/domain/
git commit -m "chore: scaffold @ai-sdlc/domain package"
```

---

### Task 5: Scaffold `packages/application`

**Files:**
- Create: `packages/application/package.json`
- Create: `packages/application/tsconfig.json`
- Create: `packages/application/src/index.ts`
- Create: `packages/application/src/__tests__/smoke.test.ts`

- [ ] **Step 5.1: Create `packages/application/package.json`**

```json
{
  "name": "@ai-sdlc/application",
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

- [ ] **Step 5.2: Create `packages/application/tsconfig.json`**

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

- [ ] **Step 5.3: Create `packages/application/src/index.ts`**

```ts
export const packageName = '@ai-sdlc/application';
```

- [ ] **Step 5.4: Create `packages/application/src/__tests__/smoke.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { packageName } from '../index.js';

describe('@ai-sdlc/application', () => {
  it('exports a package name', () => {
    expect(packageName).toBe('@ai-sdlc/application');
  });
});
```

- [ ] **Step 5.5: Commit**

```bash
git add packages/application/
git commit -m "chore: scaffold @ai-sdlc/application package"
```

---

### Task 6: Scaffold `packages/infrastructure`

**Files:**
- Create: `packages/infrastructure/package.json`
- Create: `packages/infrastructure/tsconfig.json`
- Create: `packages/infrastructure/src/index.ts`
- Create: `packages/infrastructure/src/__tests__/smoke.test.ts`

- [ ] **Step 6.1: Create `packages/infrastructure/package.json`**

```json
{
  "name": "@ai-sdlc/infrastructure",
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

- [ ] **Step 6.2: Create `packages/infrastructure/tsconfig.json`**

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

- [ ] **Step 6.3: Create `packages/infrastructure/src/index.ts`**

```ts
export const packageName = '@ai-sdlc/infrastructure';
```

- [ ] **Step 6.4: Create `packages/infrastructure/src/__tests__/smoke.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { packageName } from '../index.js';

describe('@ai-sdlc/infrastructure', () => {
  it('exports a package name', () => {
    expect(packageName).toBe('@ai-sdlc/infrastructure');
  });
});
```

- [ ] **Step 6.5: Commit**

```bash
git add packages/infrastructure/
git commit -m "chore: scaffold @ai-sdlc/infrastructure package"
```

---

### Task 7: Scaffold `apps/api`

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/src/index.ts`
- Create: `apps/api/src/__tests__/smoke.test.ts`

- [ ] **Step 7.1: Create `apps/api/package.json`**

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

- [ ] **Step 7.2: Create `apps/api/tsconfig.json`**

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

- [ ] **Step 7.3: Create `apps/api/src/index.ts`**

```ts
export const packageName = '@ai-sdlc/api';
```

- [ ] **Step 7.4: Create `apps/api/src/__tests__/smoke.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { packageName } from '../index.js';

describe('@ai-sdlc/api', () => {
  it('exports a package name', () => {
    expect(packageName).toBe('@ai-sdlc/api');
  });
});
```

- [ ] **Step 7.5: Commit**

```bash
git add apps/api/
git commit -m "chore: scaffold @ai-sdlc/api app"
```

---

### Task 8: Scaffold `apps/web` placeholder

**Files:**
- Create: `apps/web/package.json` (minimal placeholder only)

- [ ] **Step 8.1: Create `apps/web/package.json`**

```json
{
  "name": "@ai-sdlc/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "echo 'no-op until Task 7'"
  }
}
```

- [ ] **Step 8.2: Commit**

```bash
git add apps/web/
git commit -m "chore: scaffold @ai-sdlc/web placeholder"
```

---

### Task 9: Install dependencies

- [ ] **Step 9.1: Enable corepack and install**

```bash
corepack enable
corepack prepare pnpm@9.12.3 --activate
pnpm install
```

Expected: `pnpm-lock.yaml` created, no errors.

- [ ] **Step 9.2: Verify lockfile created**

```bash
ls pnpm-lock.yaml
```

Expected: file exists.

- [ ] **Step 9.3: Commit lockfile**

```bash
git add pnpm-lock.yaml
git commit -m "chore: add pnpm-lock.yaml"
```

---

### Task 10: Verify all commands pass

- [ ] **Step 10.1: Run typecheck**

```bash
pnpm -r typecheck
```

Expected: exits 0 with no errors.

- [ ] **Step 10.2: Run lint**

```bash
pnpm lint
```

Expected: exits 0 with no warnings.

- [ ] **Step 10.3: Run tests**

```bash
pnpm test
```

Expected: smoke test in each package prints PASS, exits 0.

- [ ] **Step 10.4: Run build**

```bash
pnpm build
```

Expected: exits 0, no errors.

---

### Task 11: Add CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 11.1: Create `.github/workflows/ci.yml`**

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

- [ ] **Step 11.2: Commit CI**

```bash
git add .github/workflows/ci.yml
git commit -m "chore: add GitHub Actions CI workflow"
```

---

### Task 12: Final verification

- [ ] **Step 12.1: Run full verification suite**

```bash
pnpm -r typecheck && pnpm lint && pnpm test && pnpm build
```

Expected: all exit 0.

- [ ] **Step 12.2: Final commit (if needed)**

```bash
git status
```

Ensure all changes are committed.

---

## Tests to Add or Update

### Smoke tests to create

| Package | Test File |
|---------|-----------|
| `@ai-sdlc/shared` | `packages/shared/src/__tests__/smoke.test.ts` |
| `@ai-sdlc/domain` | `packages/domain/src/__tests__/smoke.test.ts` |
| `@ai-sdlc/application` | `packages/application/src/__tests__/smoke.test.ts` |
| `@ai-sdlc/infrastructure` | `packages/infrastructure/src/__tests__/smoke.test.ts` |
| `@ai-sdlc/api` | `apps/api/src/__tests__/smoke.test.ts` |

Each smoke test imports `packageName` from `../index.js` and asserts it equals the fully-scoped package name.

---

## Validation Commands

Run in sequence to verify the implementation:

```bash
# 1. Enable pnpm and install dependencies
corepack enable
corepack prepare pnpm@9.12.3 --activate
pnpm install

# 2. Typecheck all packages
pnpm -r typecheck

# 3. Lint all code
pnpm lint

# 4. Run all tests
pnpm test

# 5. Build all packages
pnpm build
```

Expected results:
- `pnpm install` — creates `pnpm-lock.yaml`, no errors
- `pnpm -r typecheck` — exits 0, no errors
- `pnpm lint` — exits 0, no warnings
- `pnpm test` — all 5 smoke tests pass
- `pnpm build` — exits 0, creates `dist/` directories

---

## Risk Areas

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| ESLint 9 flat config + `@typescript-eslint` v8 compatibility issues | Medium | Use exact versions from issue-comments.md (`@typescript-eslint/eslint-plugin: ^8.13.0`, `@typescript-eslint/parser: ^8.13.0`, `eslint: ^9.14.0`) |
| `apps/web` placeholder causes `pnpm -r typecheck` to fail | Low | `apps/web` has a no-op typecheck script; the other 5 packages all have real `tsc -p tsconfig.json --noEmit` |
| `pnpm install --frozen-lockfile` fails if lockfile is out of date | Low | Lockfile committed as part of this issue; developers run `pnpm install` (not `--frozen-lockfile`) when adding deps |
| TypeScript strict mode flags cause build failures in future work | Low | Flags are intentional and non-negotiable per design doc; inherit from base config |

---

## Stop Conditions

**Abort and do not proceed if:**

1. `pnpm install` fails with dependency resolution errors — fix root `package.json` devDependencies first
2. `pnpm -r typecheck` fails with TypeScript compilation errors — fix `tsconfig.base.json` or per-package `tsconfig.json` before proceeding
3. `pnpm lint` fails with ESLint configuration errors — fix `eslint.config.mjs` before proceeding
4. `pnpm test` fails — fix the failing smoke test before proceeding
5. Any file is created outside the listed scope (e.g., domain types, React components, SQLite)
6. CI workflow has syntax errors — fix `.github/workflows/ci.yml`

**Do NOT abort for:**
- `apps/web` having only a placeholder `package.json` (expected, per design)
- Missing Husky/lint-staged (explicitly out of scope)
- Missing Turborepo/Nx (explicitly out of scope)

---

## Assumptions Documented

1. Node 22 is the target runtime (per `.nvmrc` and existing Bash scripts)
2. pnpm 9.12.3 is pinned via `packageManager` field and corepack
3. TypeScript strict mode is non-negotiable
4. `apps/web` placeholder is intentional — Next.js lands in Task 7
5. No feature code in this issue — only shell/bootstrap
6. No Husky/lint-staged/commitlint in this issue
7. CI uses `ubuntu-latest` standard GitHub Actions runner
8. `pnpm-lock.yaml` is committed to enable `--frozen-lockfile` in CI
