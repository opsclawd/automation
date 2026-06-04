---
title: Local config override via .ai-orchestrator.local.json
date: 2026-06-04
category: orchestrator
module: shared
problem_type: git-divergence
component: config
symptoms:
  - Config tweaks to .ai-orchestrator.json are committed to main and not pushed immediately
  - Concurrent PR merges cause branch divergence requiring manual git reset --hard
  - Local config changes are lost when resetting to origin/main
root_cause: shared-config-is-git-tracked
resolution_type: feature
severity: medium
related_components:
  - packages/shared/src/config/loader.ts
  - packages/shared/src/config/schema.ts
  - packages/shared/src/config/__tests__/loader.test.ts
  - packages/shared/src/config/errors.ts
  - .gitignore
tags:
  - config
  - deep-merge
  - local-override
  - gitignore
---

# Local Config Override via `.ai-orchestrator.local.json`

## Problem

Config tweaks to `.ai-orchestrator.json` (e.g., swapping agent profiles, adjusting `phaseProfiles`) were committed directly to `main` without being pushed immediately. When a PR merged to `origin/main` at the same time, the branches diverged and required a manual `git reset --hard origin/main`, which discarded the local config change. This was a recurring friction point during parallel development.

## What Was Done

1. Added a `deepMerge` utility and `LOCAL_CONFIG_FILENAME` constant (`packages/shared/src/config/loader.ts`)
2. Extended `loadConfig` to check for `.ai-orchestrator.local.json` after parsing the base config, deep-merging it on top before Zod validation
3. Added `ConfigError` messages that reference `.ai-orchestrator.local.json` when the local file causes failures
4. Added `.ai-orchestrator.local.json` to `.gitignore`
5. Added 5 test cases covering: absent local file, deep-merge override, invalid JSON, schema failure, and adding new profile entries

## Architecture

```
loadConfig(repoRoot)
  ├─ readFileSync(.ai-orchestrator.json) → raw
  ├─ JSON.parse(raw) → json
  ├─ if .ai-orchestrator.local.json exists:
  │    ├─ readFileSync(local) → localRaw
  │    ├─ JSON.parse(localRaw) → localJson
  │    └─ deepMerge(json, localJson) → json
  ├─ orchestratorConfigSchema.safeParse(json) → parsed
  └─ return parsed.data
```

The merge happens at the raw-JSON level **before** Zod validation. This means the local file can be partial — it only needs to contain the keys being overridden. Validation runs on the merged result, so cross-field constraints (e.g., `phaseProfiles.implement.profile` referencing an existing profile) are enforced.

## Key Implementation Decisions

### Decision 1: Merge at the JSON level, then validate

**Chosen:** Merge raw JSON before Zod parsing, not after.

**Rationale:** Validating the merged result means full schema checking including cross-field validations. Validating each file independently would fail almost always since the local file only contains partial overrides.

If the merged result fails schema, the error message appends `(validated with overrides from .ai-orchestrator.local.json)` when the local file is present (`loader.ts:74-76`):

```typescript
const hasLocal = existsSync(localPath);
const extraMsg = hasLocal ? ` (validated with overrides from ${LOCAL_CONFIG_FILENAME})` : '';
throw new ConfigError(`${formatZodError(parsed.error)}${extraMsg}`, parsed.error);
```

### Decision 2: Prototype pollution guard in `deepMerge`

**Chosen:** Skip `__proto__`, `constructor`, and `prototype` keys during recursion.

**Rationale:** Since `deepMerge` iterates over `Object.keys(override)`, a malicious local file could inject prototype-polluting keys. While `JSON.parse` can't produce a crafted prototype via standard JSON, the guard is defense-in-depth for the ~15-line utility.

```typescript
for (const key of Object.keys(override)) {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
    continue;
  }
  result[key] = deepMerge(/* ... */);
}
```

### Decision 3: Arrays are replaced wholesale, not concatenated

**Chosen:** `isPlainObject` returns `false` for arrays, so array values hit the base-case `return override`.

**Rationale:** If you override `phases.skip`, you mean "skip these instead," not "skip these too." This matches developer intuition for config overrides.

### Decision 4: No new dependencies

**Chosen:** Implement `deepMerge` as a ~15-line utility in `loader.ts` rather than adding a library.

**Rationale:** The `shared` package has only two runtime deps (`zod`, `uuid`). A small utility is preferable to a dependency for a single use case.

### Decision 5: Local file is optional

**Chosen:** If `.ai-orchestrator.local.json` doesn't exist, behavior is identical to before.

**Rationale:** Purely additive. No existing behavior changes. No feature flags required.

## Gotchas and Pitfalls

### ConfigError messages reference the local file

When the local file has invalid JSON, the `ConfigError` message explicitly includes `.ai-orchestrator.local.json`:

```typescript
throw new ConfigError(
  `Invalid JSON in ${LOCAL_CONFIG_FILENAME}: ${(err as Error).message}`,
  err,
);
```

This is also tested at `loader.test.ts:151`:

```typescript
expect(() => loadConfig(repo)).toThrow(/\.ai-orchestrator\.local\.json/);
```

### Schema errors after merge are ambiguous

If the local file references a nonexistent profile (e.g., `phaseProfiles.implement.profile: "nonexistent"`), the Zod error will show the field path but not which file introduced the bad value. This is mitigated by the extra message appended to schema errors when the local file exists (`loader.ts:74-76`), but the exact problematic value isn't pinpointed.

**Workaround:** Temporarily move `.ai-orchestrator.local.json` out of the repo root to isolate whether the base config is at fault.

### `deepMerge` is shallow on the base object

The spread `{ ...base }` at `loader.ts:16` creates a shallow copy. Nested object references from `base` are preserved until `deepMerge` recurses into them. This means in the unusual case where `base` has a nested object and `override` has `null` for that key, the merge will produce `null` (override wins), not a deep deletion. This is acceptable for the config use case.

## Testing

Five new test cases in `packages/shared/src/config/__tests__/loader.test.ts`:

| Test | Scenario | Assertion |
|------|---------|-----------|
| `returns base config when no local file exists` | Local file absent | `agent.phaseProfiles.implement.profile === 'senior'` |
| `deep-merges local config on top of base config` | Partial local override | `implement.profile === 'junior'`, `review.profile === 'junior'` (base preserved), `profiles.senior` defined (base preserved), `validation.commands` unchanged |
| `throws ConfigError for invalid JSON in local config` | Local file has `{ not json` | Throws `ConfigError` matching `/\.ai-orchestrator\.local\.json/` |
| `throws ConfigError when merged result fails schema` | Local references nonexistent profile | Throws `ConfigError` matching `/phaseProfiles\.implement\.profile/` |
| `allows local file to add new profile entries` | Local adds `fast` profile and `compound` phase | `profiles.fast` defined, `phaseProfiles.compound.profile === 'fast'` |

## Files Changed

| File | Change |
|------|--------|
| `packages/shared/src/config/loader.ts` | Added `LOCAL_CONFIG_FILENAME`, `isPlainObject`, `deepMerge`; extended `loadConfig` with local file loading branch |
| `packages/shared/src/config/__tests__/loader.test.ts` | Added `writeLocalConfig` helper, `BASE_CONFIG`, `BASE_WITH_AGENT` constants, 5 new test cases |
| `.gitignore` | Added `.ai-orchestrator.local.json` |

Commits:
- `8a96d2150a7ce0c506fe619570308b2fa65ee0bf` — feat(config): add local config override via .ai-orchestrator.local.json
- `19fb3346b3f616e55be4b028f9f1a0e8f534eb5c` — chore: gitignore .ai-orchestrator.local.json

## What to Know Before Modifying

- **The local file is entirely optional.** All existing behavior is preserved when `.ai-orchestrator.local.json` is absent. The check at `loader.ts:51` (`existsSync(localPath)`) is the gate.
- **Merge happens before validation.** The Zod schema validates the merged JSON, not each file independently. A partial local file (e.g., only `agent.phaseProfiles`) is fine because the base config fills in the rest before validation.
- **Arrays are replaced, not merged.** If you need to append to an array, you must include the full new array in the local file.
- **Prototype pollution guard.** If you modify `deepMerge` to remove the `__proto__`/`constructor`/`prototype` skip logic, re-evaluate the security implications — the local file is user-controlled and could theoretically contain crafted keys if loaded from a different context.
- **Error messages include local file context.** When schema validation fails and a local file exists, the error message appends the note about overrides. This helps users understand why a valid-base-config is suddenly failing.
- **The `.gitignore` entry is critical.** Without it, the local file could be accidentally committed and distributed, negating the entire purpose. Verify it's present with `rg '\.ai-orchestrator\.local\.json' .gitignore`.
