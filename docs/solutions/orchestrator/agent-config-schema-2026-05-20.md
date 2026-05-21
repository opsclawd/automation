---
title: Agent config schema for profiles and phase routing in .ai-orchestrator.json
date: 2026-05-20
category: orchestrator
module: shared
problem_type: schema_gap
component: config_validation
symptoms:
  - No schema-driven validation for agent runtime profiles
  - Dangling profile references silently pass config validation
  - Pi runtime contextLimitTokens requirement not enforced at schema level
  - No typed contract for agent config before adapter implementation
root_cause: missing_schema_section
resolution_type: schema_extension
severity: medium
related_components:
  - config-loader
  - agent-registry
tags:
  - zod
  - config-schema
  - agent-profiles
  - phase-routing
  - superRefine
  - cross-field-validation
  - m3-08
---

# Agent config schema for profiles and phase routing in `.ai-orchestrator.json`

## Problem

The orchestrator config (`packages/shared/src/config/schema.ts`) validated `validation`, `phases`, and `timeouts` but had no `agent` section. Without it:

- Operators could not declare per-phase agent runtime routing declaratively.
- Dangling references (a `phaseProfiles` entry pointing to a non-existent profile) passed validation silently and only failed at invocation time with opaque errors.
- The `pi` runtime's `contextLimitTokens` requirement had no enforcement point.
- M4 (which invokes agents) had no typed config contract from shared.

Issue #71 (M3-08) added the schema **before** any adapter ships, so invalid configurations fail fast with precise error paths.

## Solution

Four new Zod schemas added to `packages/shared/src/config/schema.ts`:

### `agentRuntime` — closed enum

```ts
const agentRuntime = z.enum(['opencode', 'pi']);
```

Closed set per ADR-0007. Adding a new runtime is a deliberate act (requires writing a new adapter), not a config toggle. Unknown values fail at parse time with a clear enum error — not as silent strings.

**Drift risk:** `AgentRuntimeKind` in `packages/application/src/agent/types.ts` defines the same set as a TypeScript union. No compile-time link exists because `shared` has no workspace dependencies (layer rule). A comment in `schema.ts` flags this: "Keep in sync with AgentRuntimeKind in @ai-sdlc/application/agent/types.ts". Adding a runtime requires updating both — the set is intentionally small.

### `agentProfileSchema` — profile with Pi constraint

```ts
const agentProfileSchema = z
  .object({
    runtime: agentRuntime,
    provider: z.string().min(1),
    model: z.string().min(1),
    contextLimitTokens: z.number().int().positive().optional(),
    promptBudgetTokens: z.number().int().positive().optional(),
    outputBudgetTokens: z.number().int().positive().optional(),
    timeoutMinutes: z.number().positive(), // fractional minutes intentionally allowed
  })
  .superRefine((profile, ctx) => {
    if (profile.runtime === 'pi' && profile.contextLimitTokens === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contextLimitTokens'],
        message: 'pi profiles require contextLimitTokens',
      });
    }
  });
```

Key detail: `timeoutMinutes` uses `z.number().positive()` (not `.int().positive()`), intentionally allowing fractional values like 0.5 minutes. The `contextLimitTokens` requirement mirrors the existing runtime validation in `packages/application/src/agent/types.ts:validateAgentProfile()`.

### `phaseProfileEntrySchema` — phase-to-profile mapping

```ts
const phaseProfileEntrySchema = z.object({
  profile: z.string().min(1),
  fallbackProfile: z.string().min(1).optional(),
});
```

Phase keys are arbitrary strings (`z.record`), not a fixed enum. Unknown phase names silently pass schema validation and only fail at runtime lookup (M3-10 adds enforcement).

### `agentSchema` — cross-field reference validation

```ts
const agentSchema = z
  .object({
    defaultProfile: z.string().min(1),
    profiles: z.record(z.string().min(1), agentProfileSchema),
    phaseProfiles: z.record(z.string().min(1), phaseProfileEntrySchema),
  })
  .superRefine((agent, ctx) => {
    const names = new Set(Object.keys(agent.profiles));
    if (!names.has(agent.defaultProfile)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultProfile'],
        message: `defaultProfile '${agent.defaultProfile}' is not defined in profiles`,
      });
    }
    for (const [phaseName, entry] of Object.entries(agent.phaseProfiles)) {
      if (!names.has(entry.profile)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['phaseProfiles', phaseName, 'profile'],
          message: `phaseProfiles.${phaseName}.profile '${entry.profile}' is not defined in profiles`,
        });
      }
      if (entry.fallbackProfile && !names.has(entry.fallbackProfile)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['phaseProfiles', phaseName, 'fallbackProfile'],
          message: `phaseProfiles.${phaseName}.fallbackProfile '${entry.fallbackProfile}' is not defined in profiles`,
        });
      }
    }
  });
```

The `superRefine` checks three classes of dangling reference with precise Zod issue paths:

| Error                                      | Path example                                        |
| ------------------------------------------ | --------------------------------------------------- |
| Unknown `defaultProfile`                   | `['defaultProfile']`                                |
| Unknown `phaseProfiles[*].profile`         | `['phaseProfiles', 'plan-design', 'profile']`       |
| Unknown `phaseProfiles[*].fallbackProfile` | `['phaseProfiles', 'implement', 'fallbackProfile']` |

The existing `formatZodError` in `loader.ts` handles these automatically — no loader changes needed.

### `agent` is `.optional()` on the top-level schema

```ts
export const orchestratorConfigSchema = z.object({
  validation: validationSchema,
  phases: phasesSchema,
  timeouts: timeoutsSchema,
  agent: agentSchema.optional(),
});

export type AgentConfig = NonNullable<OrchestratorConfig['agent']>;
```

Optional in M3 for backward compatibility. M4 starts requiring it. `AgentConfig` is derived from the inferred `OrchestratorConfig` type (not an independent interface) so it stays synchronized with the schema.

## Why `superRefine` Instead of Post-Parse Validation

Alternative: validate references in `loader.ts` after `safeParse` succeeds. Rejected because:

- It splits validation logic between schema and loader, making the schema an incomplete contract.
- The loader already delegates all validation to the schema; breaking that pattern is inconsistent.
- `superRefine` produces precise `path` arrays that `formatZodError` already knows how to format.

Trade-off: `superRefine` is imperative (not declarative like basic field constraints), but it keeps all validation in one place.

## Why `z.record` Instead of Fixed Keys

`profiles` and `phaseProfiles` use `z.record(z.string().min(1), ...)` so profile names are user-defined, not a fixed set of keys. For `phaseProfiles`, this means unknown phase names (e.g., `plan-desgin`) silently pass schema validation and only fail at runtime lookup. This is explicitly accepted — M3-10 will add runtime enforcement of phase names.

## Files Changed

| Action    | Path                                                 | Purpose                                                       |
| --------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| Modified  | `packages/shared/src/config/schema.ts`               | Added 4 Zod schemas + `AgentConfig` type export               |
| Created   | `packages/shared/src/__tests__/agent-config.test.ts` | 9 test cases + regression guard                               |
| Modified  | `.ai-orchestrator.json`                              | Added illustrative `agent` block with `_comment` warning      |
| No change | `packages/shared/src/config/loader.ts`               | Already handles new issues via `safeParse` + `formatZodError` |
| No change | `packages/shared/src/index.ts`                       | `AgentConfig` already reachable via wildcard re-export        |

## Test Coverage

`packages/shared/src/__tests__/agent-config.test.ts` — 9 test cases:

1. Valid agent config parses
2. Unknown runtime rejected
3. Dangling `phaseProfiles[*].profile` rejected with precise path
4. Dangling `phaseProfiles[*].fallbackProfile` rejected
5. Unknown `defaultProfile` rejected
6. Pi profile missing `contextLimitTokens` rejected
7. Negative `promptBudgetTokens` rejected
8. Empty profiles with non-empty `defaultProfile` rejected
9. Committed `.ai-orchestrator.json` parses (regression guard)

The regression test uses `import.meta.dirname` (Node 22+; project requires `node>=22.0.0`) to resolve the repo root at `../../` from the test file. Note the path has **four** `..` segments because vitest resolves `import.meta.dirname` to `packages/shared/src/__tests__/` and `.ai-orchestrator.json` lives at the worktree root.

## Gotchas and Pitfalls

1. **`agentRuntime` / `AgentRuntimeKind` drift.** Both define the same closed set in different packages. No compile-time link between them. When adding a runtime, update both `packages/shared/src/config/schema.ts:20` and `packages/application/src/agent/types.ts`.

2. **`phaseProfiles` keys are not validated.** A typo in a phase name passes schema validation. M3-10 will enforce this at runtime.

3. **`timeoutMinutes` allows floats.** `z.number().positive()` (not `.int().positive()`). A 0.5-minute timeout is valid.

4. **`ZodIssueCode.custom` has no machine-readable error code.** Consumers switching on Zod issue codes cannot distinguish "dangling profile reference" from other custom refinements. The `message` and `path` are the primary error contract.

5. **The `_comment` key in `.ai-orchestrator.json`.** The sample config has a `_comment` field warning that model names are illustrative. This key is not in the schema and Zod strips unknown keys by default, so it does not cause parse failures.

6. **Phase names `review` and `fix-review` are separate entries.** M8-06 collapses them into `review-fix`. Until then, the sample config must use the legacy names.

7. **The regression test path is worktree-relative.** The test resolves `.ai-orchestrator.json` via `import.meta.dirname`, which yields the worktree root — not the main workspace root. If the test is run outside a worktree (e.g., from the main workspace), the path may resolve differently.

## What to Know Before Modifying This Code

- Adding a new agent runtime: Update `agentRuntime` enum in `schema.ts` **and** `AgentRuntimeKind` in `application/agent/types.ts`. The comment at line 19 of `schema.ts` flags this.
- Making `agent` required: Remove `.optional()` from `agent: agentSchema.optional()` in `orchestratorConfigSchema`. This is M4's responsibility.
- Adding phase name validation: Do not add it to the Zod schema — M3-10 will handle it in the agent registry at runtime. The schema intentionally validates structure and cross-references only.
- The `loader.ts` pipeline (`safeParse` + `formatZodError`) already handles any new `superRefine` issues automatically. No loader changes needed for new custom validation rules added to the schema.
