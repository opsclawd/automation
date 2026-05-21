---
title: Agent runtime registry at the composition root with per-profile dispatch resolution
date: 2026-05-21
category: orchestrator
module: apps/api
problem_type: composition_root_wiring
component: agent_runtime_registry
symptoms:
  - No single place wires agent profiles to adapters
  - Phase handlers would need to parse agent.phaseProfiles themselves
  - Tests had no seam to swap agent implementations cleanly
  - Adding a real runtime adapter required domain or application changes
root_cause: missing_composition_root_layer
resolution_type: new_class
severity: medium
related_components:
  - apps/api/src/agent-runtime-registry.ts
  - apps/api/src/compose.ts
  - apps/api/src/__tests__/compose-agent.test.ts
  - packages/application/package.json
  - packages/application/src/test-doubles/index.ts
  - packages/shared/src/config/schema.ts
tags:
  - composition-root
  - agent-profiles
  - ports-and-adapters
  - runtime-dispatch
  - test-doubles
  - subpath-exports
  - exactOptionalPropertyTypes
  - ConfigError
  - m3-10
  - issue-73
---

# Agent runtime registry at the composition root with per-profile dispatch resolution

## Problem

`apps/api/src/compose.ts` built a `Container` with infrastructure adapters (SQLite repos, event bus, bash runner) but had no seam for agent runtime selection. Phase handlers that need agent invocation would have to parse `agent.phaseProfiles` themselves and know which adapter to dispatch to.

This mattered because M4 adds two real agent runtimes (`opencode` and `pi`) with different capabilities and configurations. Without a registry, every phase handler becomes coupled to runtime selection logic. Tests also need to swap the entire agent layer — the registry makes this a single-line replacement in the composition root.

## Solution

Introduce an `AgentRuntimeRegistry` class in `apps/api/src/` that takes `{ agent: AgentConfig; adapters: Partial<Record<AgentRuntimeKind, AgentPort>> }` and exposes:

1. **`agentPort: AgentPort`** — dispatches `invoke(req)` to the adapter matching `agent.profiles[req.profile].runtime`.
2. **`resolveProfileForPhase(phaseName): AgentProfileName`** — looks up `agent.phaseProfiles[phaseName]`, throws `ConfigError` on unknown phase.

Wire it into `composeRoot()` as an optional `agentRuntime` field on `Container`, registered with `FakeAgentPort` for both `opencode` and `pi` runtimes.

## Implementation

### Files created

- **`apps/api/src/agent-runtime-registry.ts`** — The registry class (36 lines).

  Constructor stores options privately and creates `this.agentPort` as an inline `AgentPort` implementation:

  ```ts
  constructor(private readonly opts: AgentRuntimeRegistryOptions) {
    this.agentPort = {
      invoke: (req) => {
        const profile = opts.agent.profiles[req.profile];
        if (!profile) throw new ConfigError(`unknown profile ${req.profile}`);
        const adapter = opts.adapters[profile.runtime];
        if (!adapter) throw new ConfigError(`no adapter registered for runtime ${profile.runtime}`);
        return adapter.invoke(req);
      },
    };
  }
  ```

  `adapters` uses `Partial<Record<...>>` so you can register only the runtimes you actually have adapters for.

  `resolveProfileForPhase` is a direct lookup — no legacy name remapping. Unknown phase name throws `ConfigError`:

  ```ts
  resolveProfileForPhase(phaseName: string): AgentProfileName {
    const entry = this.opts.agent.phaseProfiles[phaseName];
    if (!entry)
      throw new ConfigError(`unknown phase '${phaseName}' — no entry in agent.phaseProfiles`);
    return AgentProfileName(entry.profile);
  }
  ```

- **`apps/api/src/__tests__/compose-agent.test.ts`** — 4 test cases (121 lines):

  | Test                                                                            | What it verifies                                         |
  | ------------------------------------------------------------------------------- | -------------------------------------------------------- |
  | `resolveProfileForPhase returns the configured profile name`                    | Direct lookup works for known phase                      |
  | `resolveProfileForPhase throws on unknown phase`                                | `ConfigError` is thrown, not a generic `Error`           |
  | `agentPort.invoke dispatches to the adapter for the requested profile runtime`  | Only the matching `FakeAgentPort` records the invocation |
  | `invoke throws ConfigError when no adapter is registered for a profile runtime` | Missing adapter produces a typed error                   |

### Files modified

- **`packages/application/package.json`** — Added `./test-doubles` subpath export:

  ```json
  "./test-doubles": {
    "development": "./src/test-doubles/index.ts",
    "types": "./dist/test-doubles/index.d.ts",
    "import": "./dist/test-doubles/index.js"
  }
  ```

  No `tsconfig.json` changes needed — `rootDir: "src"` and `include: ["src/**/*"]` already cover `src/test-doubles/`. The existing `exclude` only skips `__tests__/` and `*.test.ts`.

- **`apps/api/src/compose.ts`** — Three changes:
  1. **Imports added**: `ConfigError`, `loadConfig` from `@ai-sdlc/shared`; `FakeAgentPort` from `@ai-sdlc/application/test-doubles`; `AgentRuntimeRegistry` from local module.

  2. **`Container` interface** — `agentRuntime: AgentRuntimeRegistry | undefined` (not `agentRuntime?` — see gotcha below).

  3. **`composeRoot()` wiring** — After existing setup, wrapped in a try-catch:

     ```ts
     let agentRuntime: AgentRuntimeRegistry | undefined;
     try {
       const config = loadConfig(opts.repoRoot);
       if (config.agent) {
         agentRuntime = new AgentRuntimeRegistry({
           agent: config.agent,
           adapters: {
             opencode: new FakeAgentPort({}),
             pi: new FakeAgentPort({}),
           },
         });
       }
     } catch (err) {
       if (!(err instanceof ConfigError)) throw err;
     }

     return {
       // ... other fields
       ...(agentRuntime ? { agentRuntime } : {}),
     };
     ```

     Spread-with-conditional prevents the key from appearing at all when `agentRuntime` is undefined, which matters for TypeScript's `exactOptionalPropertyTypes`.

## Key design decisions

### 1. Registry in `apps/api`, not in domain or application

The registry is pure composition root territory — it wires config (from shared) to adapters (from application). Placing it in `apps/api` preserves the inward-only layer rule. Domain and application layers stay pure.

**Alternative considered:** Put profile resolution logic in the application layer as a use case. Rejected because the registry's only job is wiring — it has no business logic beyond looking up keys and dispatching.

### 2. `adapters: Partial<Record<AgentRuntimeKind, AgentPort>>` over full `Record`

A full `Record<AgentRuntimeKind, AgentPort>` would require registering every runtime (including ones you haven't implemented yet). `Partial` lets M3 register only `opencode` and `pi` fakes without needing a `noop` adapter for future runtimes.

### 3. `ConfigError` for all lookup failures

Both missing profile and missing adapter throw `ConfigError` (from `@ai-sdlc/shared`), making them distinguishable from runtime errors. Callers can catch `ConfigError` to provide fallback behavior in M4.

The review loop tightened this: the initial implementation used `Error`, but `ConfigError` is more precise and matches the invariant that these are configuration-time problems (bad config, missing adapter registration) surfaced at invocation time.

### 4. `Container.agentRuntime` uses `| undefined` union over optional `?` property

Initial implementation used `agentRuntime?: AgentRuntimeRegistry`. When `tsconfig.json` has `exactOptionalPropertyTypes: true` (which this project does), `{ agentRuntime: undefined }` is **not** assignable to `{ agentRuntime?: AgentRuntimeRegistry }` — the property must be absent, not present-but-`undefined`. The spread `...(agentRuntime ? { agentRuntime } : {})` conditionally omits the key.

The fix commit (e8579f9) changed the type to `agentRuntime: AgentRuntimeRegistry | undefined` — the union type accepts both a value and `undefined`, matching the spread behavior.

### 5. Catch `ConfigError` in `composeRoot`, not all errors

The initial plan used a bare `catch {}`. The review tightened it to `catch (err) { if (!(err instanceof ConfigError)) throw err; }`. This prevents silent swallowing of unexpected errors (e.g., `TypeError` from a bug in `loadConfig`) while still gracefully handling the "no config file" case.

### 6. Test-doubles subpath export follows existing barrel convention

`packages/application/src/test-doubles/index.ts` already existed and exported `FakeAgentPort`. Adding the `./test-doubles` subpath to `package.json`'s `exports` map made it importable as `@ai-sdlc/application/test-doubles` — no files needed to be moved or renamed.

## Gotchas and pitfalls

### 1. `exactOptionalPropertyTypes` breaks `{ foo?: T }` with `{ foo: undefined }`

If `tsconfig.json` has `exactOptionalPropertyTypes: true`, a property declared as `foo?: T` rejects assignment of `{ foo: undefined }`. The spread `...(cond ? { foo } : {})` produces `{ foo: undefined }` or `{}`, never the absent-key form. Fix: declare the type as `foo: T | undefined` instead of `foo?: T`.

**Check your project's `tsconfig.json` before deciding which pattern to use.**

### 2. `loadConfig` throws on missing file

`composeRoot()` calls `loadConfig(opts.repoRoot)` which throws `ConfigError` if no `.ai-orchestrator.json` exists. Existing `compose.test.ts` tests create temp directories without config files. The try-catch is mandatory for backward compatibility — without it, every existing test breaks.

### 3. `adapters` must be `Partial` for M3

If you use `Record<AgentRuntimeKind, AgentPort>` you must register every runtime. M3 only has `opencode` and `pi` fakes. Using `Partial` also means the registry itself must guard against missing adapters at invocation time (line 23-24 of `agent-runtime-registry.ts`).

### 4. `AgentRuntimeKind` and `agentRuntime` enum must stay in sync

`packages/application/src/agent/types.ts` defines `AgentRuntimeKind` as a TypeScript union. `packages/shared/src/config/schema.ts` defines `agentRuntime` as a Zod enum. They represent the same closed set but have no compile-time link. Adding a runtime requires updating both files.

### 5. `dist/test-doubles/` must exist for `pnpm test` to resolve

If `pnpm --filter @ai-sdlc/application build` hasn't been run, `dist/test-doubles/` doesn't exist and imports from `@ai-sdlc/application/test-doubles` fail at runtime. During development, the `development` condition in the exports map points to `./src/test-doubles/index.ts`, so TS resolution works. But Vitest uses Node's ESM resolver which respects the `exports` map — if `development` is configured and the build output exists, it prefers the `development` condition.

In practice: run `pnpm --filter @ai-sdlc/application build` before running API tests.

### 6. `resolveProfileForPhase` has no legacy name remapping

Phase names are looked up directly in `agent.phaseProfiles`. M8-06 will rename `review` + `fix-review` → `review-fix` as a coordinated rename across config, code, and tests. If phase names change before M8-06, every caller must be updated in sync.

### 7. `FakeAgentPort` with empty `{}` produces runtime errors on invoke

Registering `new FakeAgentPort({})` means any invocation against that fake will fail at runtime with no scripted responses queued. In M3 this is intentional — the fakes are placeholders. When M4 registers real adapters, the fakes are replaced.

## What someone needs to know to modify this code

### Adding a new runtime adapter (M4)

1. Write the adapter class implementing `AgentPort` in `packages/infrastructure/src/`.
2. Add the runtime string to both `agentRuntime` enum in `packages/shared/src/config/schema.ts` and `AgentRuntimeKind` in `packages/application/src/agent/types.ts`.
3. Import and instantiate the adapter in `apps/api/src/compose.ts`, adding it to the `adapters` record in the `AgentRuntimeRegistry` constructor call.
4. No changes to `AgentRuntimeRegistry` or any domain/application code.

### Making `agentRuntime` required in production

1. If config becomes mandatory: remove the `try-catch` and let `loadConfig` throw naturally.
2. Change `Container.agentRuntime` from `AgentRuntimeRegistry | undefined` to `AgentRuntimeRegistry`.
3. Remove the conditional spread: `agentRuntime` is always returned.

### Adding phase name validation

Do NOT add it to the Zod schema in `packages/shared/src/config/schema.ts`. The schema validates structure and cross-references only. Phase name enforcement belongs in `resolveProfileForPhase` in `agent-runtime-registry.ts` — which already throws `ConfigError` for unknown names.

### Adding a new method to `AgentRuntimeRegistry`

Follow the existing pattern: accept dependencies through the constructor options, keep methods synchronous unless they do I/O, use `ConfigError` for configuration-related failures.

### Testing changes to the registry

The test pattern (`compose-agent.test.ts`) uses `FakeAgentPort` instances with scripted responses to verify dispatch correctness. New tests should:

1. Create `FakeAgentPort` instances with known response data.
2. Construct `AgentRuntimeRegistry` with the fakes.
3. Assert on `fake.invocations` arrays to verify which adapter was called.

Do NOT mock `AgentPort` itself — the `FakeAgentPort` already provides reliable in-memory test doubles.

### Verification commands

```bash
pnpm --filter @ai-sdlc/application build     # build test-doubles dist before running API tests
pnpm --filter apps/api test --run            # all API tests (compose-agent + compose)
pnpm -r typecheck                            # catches exactOptionalPropertyTypes issues
pnpm depcruise                               # layer boundary check
pnpm lint                                    # linting
```

## Related

- Issue: [#73](https://github.com/opsclawd/automation/issues/73)
- Agent config schema solution: `docs/solutions/orchestrator/agent-config-schema-2026-05-20.md`
- Port conformance testing solution: `docs/solutions/domain/port-conformance-testing-2026-05-20.md`
- Layer boundaries documented in `AGENTS.md` (inward-only rule)
- Composition root at `apps/api/src/compose.ts`
