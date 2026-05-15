## Implementation Plan — Task 1: Bootstrap monorepo + tooling

**Story:** M1-01
**Commit:** `chore: bootstrap pnpm workspace, tsconfig, eslint, vitest, CI`

---

### Files to create/modify

- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.editorconfig`, `.nvmrc`, `.gitignore` (update), `eslint.config.mjs`, `.prettierrc.json`, `vitest.config.ts`
- Create: `packages/{shared,domain,application,infrastructure}/package.json`, `tsconfig.json`, `src/index.ts`, `src/__tests__/smoke.test.ts`
- Create: `apps/{api,web}/package.json`, `tsconfig.json`, placeholder `src/index.ts`
- Create: `.github/workflows/ci.yml`

---

### Step 1.1: Pin Node and set up workspace files

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

---

### Step 1.2: Create root `package.json`

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

---

### Step 1.3: Create `tsconfig.base.json`

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

---

### Step 1.4: Create `.prettierrc.json` and `eslint.config.mjs`

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

---

### Step 1.5: Create root `vitest.config.ts`

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

---

### Step 1.6: Scaffold each package and app with a smoke test

Repeat for `packages/shared`, `packages/domain`, `packages/application`, `packages/infrastructure`.

For each, replace `<name>` with the package name (`shared`, `domain`, `application`, `infrastructure`):

`packages/<name>/package.json`:
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

Then scaffold the two apps:

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

`apps/api/tsconfig.json`: same shape as packages:
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

**Do NOT** create `apps/web/tsconfig.json` or any `src/` content yet — those land in Task 7. The empty placeholder is enough for `pnpm install` and `pnpm -r typecheck` to succeed.

---

### Step 1.7: Install dependencies

```bash
corepack enable
corepack prepare pnpm@9.12.3 --activate
pnpm install
```

Expected: lockfile created, no errors.

---

### Step 1.8: Verify build / typecheck / lint / test all pass

Run sequentially and expect each to exit 0:
```bash
pnpm -r typecheck
pnpm lint
pnpm test
```

Expected: smoke test in each package prints PASS, no errors.

---

### Step 1.9: Add CI workflow

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

---

### Step 1.10: Commit

```bash
git add -A
git commit -m "chore: bootstrap pnpm workspace, tsconfig, eslint, vitest, CI"
```

---

### Conventions (apply to all tasks in this milestone)

- **TDD:** write a failing test → run it → minimal impl → run again → commit.
- **Commits:** Conventional Commits (`feat:`, `fix:`, `chore:`, `test:`, `docs:`). One commit per task unless a task explicitly says otherwise.
- **Test runner:** `pnpm -w test` runs every project's Vitest. To run one file: `pnpm --filter @ai-sdlc/<package> test -- <file>`.
- **Strict TS:** every `tsconfig.json` extends `tsconfig.base.json` which sets `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`.
- **Package names:** `@ai-sdlc/shared`, `@ai-sdlc/domain`, `@ai-sdlc/application`, `@ai-sdlc/infrastructure`, `@ai-sdlc/api`, `@ai-sdlc/web`.
- **Imports between packages:** by package name, never by relative path across package boundaries.
Automation failed: Issue body missing required section: Goal
