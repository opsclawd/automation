---
title: Local Config Override via .ai-orchestrator.local.json
date: 2026-06-04
category: developer-experience
module: config
problem_type: developer_experience
component: development_workflow
severity: medium
applies_when:
  - Developer needs to temporarily override phases, profiles, or agent configuration locally
  - Multiple developers working in parallel need different agent profiles for the same phases
  - CI/committed config needs to stay stable while local experimentation happens
tags:
  - config-override
  - local-config
  - deep-merge
  - merge-conflict-prevention
---

# Local Config Override via `.ai-orchestrator.local.json`

## Context

Config tweaks to `.ai-orchestrator.json` — swapping agent profiles, adjusting `phaseProfiles` — are committed to `main` branches that may not push immediately. When a PR merges to `origin/main` concurrently, the local branch diverges and requires `git reset --hard origin/main`, discarding the config change. This is a recurring friction point during development.

The solution needed to be additive (zero impact when the local file doesn't exist), require no new dependencies, and produce clear error messages when something goes wrong.

## Guidance

Place a partial `.ai-orchestrator.local.json` alongside `.ai-orchestrator.json` in the repo root. It deep-merges on top of the base config at load time. Only include the keys you want to override.

The implementation lives in `packages/shared/src/config/loader.ts:51-71`. Flow:

1. Parse `.ai-orchestrator.json` as before
2. If `.ai-orchestrator.local.json` exists (`existsSync`), parse it
3. `deepMerge(baseJson, localJson)` at the raw-JSON level
4. Validate the merged result against `orchestratorConfigSchema` (Zod)

### Deep-merge semantics

- **Plain objects** recurse: local overrides merge into base at each nesting level
- **Arrays** are replaced wholesale (not concatenated)
- **Primitives** overwrite the base value

```typescript
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(override)) {
    const result: Record<string, unknown> = { ...base };
    for (const key of Object.keys(override)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }
      result[key] = deepMerge(
        (base as Record<string, unknown>)[key],
        (override as Record<string, unknown>)[key],
      );
    }
    return result;
  }
  return override;
}
```

### Example

Base `.ai-orchestrator.json`:

```json
{
  "agent": {
    "defaultProfile": "senior",
    "profiles": {
      "senior": { "runtime": "opencode", "provider": "openai", "model": "gpt-4", "timeoutMinutes": 5 },
      "junior": { "runtime": "opencode", "provider": "openai", "model": "gpt-3.5", "timeoutMinutes": 3 }
    },
    "phaseProfiles": {
      "implement": { "profile": "senior" },
      "review": { "profile": "junior" }
    }
  }
}
```

Local `.ai-orchestrator.local.json`:

```json
{
  "agent": {
    "phaseProfiles": {
      "implement": { "profile": "junior" }
    }
  }
}
```

Result: `implement` phase uses `junior` locally; `review` still uses `junior`; both profiles remain defined; `validation`, `phases`, `timeouts` are untouched.

## Why This Matters

Before this change, every config tweak risked a merge conflict or required manual `git reset`. Developers avoided experimenting with profiles because reverting was painful. Now local changes are invisible to git — they cannot cause divergence, and reverting is just deleting the `.local.json` file.

The `deepMerge` approach (merge then validate) means the local file can be spartan — a single field override works — but the merged result still gets full schema validation. A stale override referencing a removed profile produces a clear `ConfigError` mentioning the local file.

## When to Apply

- Any time you need to override agent profiles, phase config, or other orchestrator settings locally without touching the committed config
- When testing a new model provider or profile that you don't want in the shared config yet
- When working on parallel branches where each needs different phase settings

## Examples

### Add a new profile and use it

```json
{
  "agent": {
    "profiles": {
      "fast": { "runtime": "opencode", "provider": "openai", "model": "gpt-4o-mini", "timeoutMinutes": 2 }
    },
    "phaseProfiles": {
      "compound": { "profile": "fast" }
    }
  }
}
```

### Override a single profile field

```json
{
  "agent": {
    "phaseProfiles": {
      "implement": { "profile": "mimo-pro", "fallbackProfile": "junior" }
    }
  }
}
```

## Gotchas and Lessons Learned

### 1. Prototype pollution protection

The `deepMerge` function needs to skip `__proto__`, `constructor`, and `prototype` keys. Without this guard, a local file like `{"__proto__": {"polluted": true}}` could pollute `Object.prototype`. This was caught in code review on the first pass (`packages/shared/src/config/loader.ts:18-20`).

### 2. Temp directory cleanup in tests

Tests create temp directories with `mkdtempSync` but the initial implementation leaked them. The fix: track created dirs in a module-level array and clean up in `afterEach` using `rmSync(dir, { recursive: true, force: true })`. See `packages/shared/src/config/__tests__/loader.test.ts:17-22`.

### 3. Error messages should reference the local file

When schema validation fails after merge, the error includes `"(validated with overrides from .ai-orchestrator.local.json)"` so developers know to check their local file for the source of the invalid value (`loader.ts:74-76`). Without this clue, error messages pointing to a config field are confusing — the field might be correct in the base config and wrong only in the local override.

### 4. Path resolution cached

The `localPath` is resolved once and reused (`loader.ts:50`) rather than calling `resolve(repoRoot, LOCAL_CONFIG_FILENAME)` multiple times. Minor optimization but avoids duplicating the path logic.

### 5. Merge then validate (not validate then merge)

If each file were validated independently, the local file would almost always fail because it only contains partial overrides. Merging at the raw-JSON level and validating the combined result is the correct order. This catches cross-field issues like a local override referencing a profile that was removed from the base config.

### 6. Arrays replace, not concatenate

This is intentional but worth noting: `phases: { skip: ["compound"] }` in the local file means "skip compound," not "skip everything plus compound." Arrays are treated as atomic values per `isPlainObject`'s `!Array.isArray` check.

## Related

- `/packages/shared/src/config/loader.ts` — main implementation
- `/packages/shared/src/config/__tests__/loader.test.ts` — tests (5 cases in `describe('loadConfig with local override')`)
- `/.gitignore` line 19 — `.ai-orchestrator.local.json` gitignore entry
- Upstream issue: #196
