---
title: Vitest include glob silently skips nested test directories
date: 2026-05-19
category: test-failures
module: vitest
problem_type: silent-test-skip
component: test-discovery
symptoms:
  - Per-package test runs show fewer tests than expected
  - Test files in nested __tests__/ directories never execute
  - CI passes but coverage is incomplete
root_cause: glob-pattern
resolution_type: bug-fix
severity: high
related_components:
  - packages/shared/vitest.config.ts
  - packages/application/vitest.config.ts
  - packages/infrastructure/vitest.config.ts
  - apps/api/vitest.config.ts
tags:
  - vitest
  - glob
  - test-discovery
  - silent-failure
  - configuration
---

# Vitest include glob silently skips nested test directories

## Problem

Per-package `vitest.config.ts` files used `include: ['src/__tests__/**/*.test.ts']`, which only matches `__tests__/` directories at the **top level** under `src/`. Test suites in nested `__tests__/` directories (e.g., `src/config/__tests__/loader.test.ts`) were silently skipped.

The root-level `vitest.config.ts` used `packages/**/__tests__/**/*.test.ts` and correctly matched nested paths, so this bug was invisible when running `pnpm test` from the repo root.

## Root Cause

The glob `src/__tests__/**/*.test.ts` has only one `**` (the "any depth" wildcard), placed _inside_ `__tests__/`. This requires `__tests__/` to be a direct child of `src/`.

```
src/__tests__/**/*.test.ts    ← only matches src/__tests__/foo.test.ts
src/**/__tests__/**/*.test.ts ← matches src/config/__tests__/loader.test.ts
```

The difference is a single `**` before `__tests__/`, but it is the difference between "only top-level `__tests__/`" and "any `__tests__/` at any depth."

## The Fix

All per-package configs now use:

```typescript
include: ['src/**/__tests__/**/*.test.ts'];
```

| Package                   | Before                         | After                           |
| ------------------------- | ------------------------------ | ------------------------------- |
| `packages/shared`         | `src/__tests__/**/*.test.ts`   | `src/**/__tests__/**/*.test.ts` |
| `packages/application`    | `src/__tests__/**/*.test.ts`   | `src/**/__tests__/**/*.test.ts` |
| `packages/infrastructure` | `src/**/*.test.ts` (too broad) | `src/**/__tests__/**/*.test.ts` |
| `apps/api`                | `src/__tests__/**/*.test.ts`   | `src/**/__tests__/**/*.test.ts` |

The infrastructure package had the opposite problem — its glob was too broad (`src/**/*.test.ts`) and was narrowed to enforce the `__tests__/` directory convention.

## Why This Is Silent

Vitest does not warn when test files exist but aren't matched by the `include` glob. Combined with `passWithNoTests: true`, a package could have zero tests running and still pass CI. The only indication is a mismatch between per-package test counts and root-level test counts.

## Detection

Check if restrictive globs were reintroduced:

```bash
grep -rn "src/__tests__" packages apps --include="vitest.config.ts"
```

Should return no results.

## Rules for Vitest include globs

1. Always place `**` before the convention directory if you want it discoverable at any nesting depth
2. `src/__tests__/**/*.test.ts` = only top-level `__tests__/`
3. `src/**/__tests__/**/*.test.ts` = any `__tests__/` at any depth
4. `passWithNoTests: true` masks the problem — always verify per-package test count
5. Run `pnpm --filter <pkg> test -- --run` to verify per-package discovery
