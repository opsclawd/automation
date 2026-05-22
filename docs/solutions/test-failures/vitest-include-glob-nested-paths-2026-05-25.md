---
title: Vitest include globs must be 'src/**/__tests__/**/*.test.ts' — nested paths silently skipped
date: 2026-05-25
category: test-failures
module: tooling
problem_type: test_discovery_bug
component: vitest-config
symptoms:
  - Per-package test commands report fewer tests than expected
  - Tests in nested __tests__/ directories not discovered
  - Package shows 1 test when 3+ exist
  - Root-level pnpm test passes while per-package test silently skips files
root_cause: restrictive_include_glob
resolution_type: convention_established
severity: medium
related_components:
  - vitest.config.ts
  - packages/*/vitest.config.ts
tags:
  - vitest
  - test-discovery
  - glob-pattern
  - nested-tests
  - include-glob
  - silent-failure
---

# Vitest include globs — `src/**/__tests__/**/*.test.ts` is correct; `src/__tests__/**/*.test.ts` silently skips nested paths

## Problem

Per-package `vitest.config.ts` files used `include: ['src/__tests__/**/*.test.ts']`. This glob has only one `**` wildcard, placed _inside_ `__tests__/`. It matches only `__tests__/` directories that are direct children of `src/`. Test files in nested `__tests__/` directories (`src/config/__tests__/`, `src/events/__tests__/`) are silently ignored.

The bug was invisible when running `pnpm test` from the repo root (root-level config uses `packages/**/__tests__/**/*.test.ts`), but manifested in per-package CI steps and developer workflows.

## Symptom pattern

| Command                              | Discovers                   | Result                      |
| ------------------------------------ | --------------------------- | --------------------------- |
| `pnpm test` (root)                   | All nested tests            | Passes                      |
| `pnpm --filter @ai-sdlc/shared test` | Only top-level `__tests__/` | Silently skips nested tests |

`passWithNoTests: true` in the config means a package with zero tests running still exits 0 — no error, no warning.

## Root cause

The glob `src/__tests__/**/*.test.ts` reads as "any depth under `__tests__/`, but `__tests__/` must be at depth 1". The `**` only covers directories _within_ `__tests__/`, not `__tests__/` itself at arbitrary depth.

```
src/__tests__/**/*.test.ts     ✓ src/__tests__/loader.test.ts
                               ✗ src/config/__tests__/loader.test.ts
                               ✗ src/events/__tests__/tailer.test.ts
```

The correct glob uses `**` before `__tests__/` to allow it at any nesting depth:

```
src/**/__tests__/**/*.test.ts  ✓ src/__tests__/loader.test.ts
                               ✓ src/config/__tests__/loader.test.ts
                               ✓ src/events/__tests__/tailer.test.ts
```

## Why the root config was correct

The root `vitest.config.ts` already used `packages/**/__tests__/**/*.test.ts` and `apps/**/__tests__/**/*.test.ts`. It worked because it placed the `**` before the directory name it needed to match at any depth.

## The silent failure mode is the real danger

Vitest doesn't warn when files exist but don't match the `include` glob. Combined with `passWithNoTests: true`, a package could have zero tests running and still pass CI. The test count in the output doesn't alert you — it just shows whatever ran.

**Prevention**: After adding any test file, run both `pnpm test` and `pnpm --filter <pkg> test` and compare counts. A mismatch is a red flag.

## Files changed

| File                                       | Change                                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| `packages/shared/vitest.config.ts`         | `src/__tests__/**/*.test.ts` → `src/**/__tests__/**/*.test.ts`                          |
| `packages/application/vitest.config.ts`    | Same fix (preventive)                                                                   |
| `apps/api/vitest.config.ts`                | Same fix (preventive)                                                                   |
| `packages/infrastructure/vitest.config.ts` | `src/**/*.test.ts` → `src/**/__tests__/**/*.test.ts` (enforced `__tests__/` convention) |

Infrastructure was the opposite problem: the glob was too broad (`src/**/*.test.ts` discovers any `.test.ts` anywhere, including outside `__tests__/` directories). Changed to `src/**/__tests__/**/*.test.ts` to enforce the `__tests__/` convention.

## Prevention

A CI check that fails if any `.test.ts` file exists outside a `__tests__/` directory would catch re-introduction:

```bash
# Would catch any .test.ts outside __tests__/
find packages apps -name '*.test.ts' -not -path '*/__tests__/*' | head -20
```

## What to know before modifying vitest config

- All per-package configs now use `include: ['src/**/__tests__/**/*.test.ts']`
- If you add a new package with a vitest config, use this same glob
- Test files **must** live in a `__tests__/` directory — outside that, they silently don't run
- `passWithNoTests: true` means zero-discovered tests pass, not fail
- After adding nested test files, verify both root and per-package test counts match expectations
