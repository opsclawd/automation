---
title: Port conformance testing for infrastructure adapters at the composition root
date: 2026-05-20
category: domain
module: packages/application
problem_type: layer_boundary_violation
component: ports
symptoms:
  - M1 SQLite repos and Bash adapter were built before M3 application ports existed
  - Classes already satisfy ports by structural typing (compose.ts wires them)
  - No compile-time assertion catches drift between adapter shape and port type
  - Adding `implements RunRepositoryPort` to infra class would violate inward-only layer rule
root_cause: ports_declared_after_adapters
resolution_type: convention_established
severity: medium
related_components:
  - packages/application/src/ports.ts
  - packages/infrastructure/src/sqlite
  - packages/infrastructure/src/bash
  - apps/api/src/compose.ts
  - apps/api/src/__tests__
tags:
  - ports
  - ports-and-adapters
  - hexagonal-architecture
  - layer-boundaries
  - structural-typing
  - typecheck-only-tests
  - vitest
  - expectTypeOf
  - conformance-testing
  - composition-root
  - m3
  - issue-72
---

# Port conformance testing for infrastructure adapters at the composition root

## Problem

M1 built five SQLite repository classes (`RunRepository`, `EventRepository`,
`FailureRepository`, `PhaseRepository`, `ArtifactRepository`) and the Bash
invocation adapter (`runBashScript`) before M3 declared the application-layer
port types in `packages/application/src/ports.ts`. The adapters already satisfy
their corresponding ports by **structural typing** — `apps/api/src/compose.ts`
wires them together without error. But there was no compile-time assertion
proving conformance. A future change to either side could silently drift,
breaking the implicit contract.

The naive fix — adding `implements RunRepositoryPort` to the infra class —
would require `packages/infrastructure` to import from `packages/application`,
violating the **inward-only layer rule** (infrastructure must not import
application, enforced by `pnpm depcruise` in CI).

## Solution

Place **typecheck-only conformance assertions** in `apps/api` (the composition
root — the only package that legally imports both `@ai-sdlc/application` and
`@ai-sdlc/infrastructure`). Use vitest's `expectTypeOf<X>().toMatchTypeOf<Y>()`
which performs a compile-time structural type check with zero runtime cost.

Add JSDoc annotations on each infra adapter export referencing its port, so a
reader looking only at the infra code can trace the contract. These are
documentation-only — no type-level effect, no new imports.

## Implementation

### Files created

- **`apps/api/src/__tests__/port-conformance.test.ts`** — 4 `expectTypeOf`
  assertions in a single vitest `describe` block:

  | Test                                                  | Adapter (infra)        | Port (application)      |
  | ----------------------------------------------------- | ---------------------- | ----------------------- |
  | `RunRepository conforms to RunRepositoryPort`         | `RunRepository`        | `RunRepositoryPort`     |
  | `EventRepository conforms to EventRepositoryPort`     | `EventRepository`      | `EventRepositoryPort`   |
  | `FailureRepository conforms to FailureRepositoryPort` | `FailureRepository`    | `FailureRepositoryPort` |
  | `runBashScript conforms to RunBashScriptFn`           | `typeof runBashScript` | `RunBashScriptFn`       |

  The test file imports **types only** from `@ai-sdlc/application` and imports
  **values** from `@ai-sdlc/infrastructure` (needed for `typeof` on
  `runBashScript`). This is legal because `apps/api` depends on both packages
  — it's the composition root.

### Files modified (JSDoc only)

| File                                                          | Annotation                                                                          | Notes                                       |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------- |
| `packages/infrastructure/src/sqlite/run-repository.ts:35`     | `/** Implements RunRepositoryPort (@ai-sdlc/application). */`                       | Above `export class RunRepository`          |
| `packages/infrastructure/src/sqlite/event-repository.ts:24`   | `/** Implements EventRepositoryPort (@ai-sdlc/application). */`                     | Above `export class EventRepository`        |
| `packages/infrastructure/src/sqlite/failure-repository.ts:4`  | `/** Implements FailureRepositoryPort (@ai-sdlc/application). */`                   | Above `export class FailureRepository`      |
| `packages/infrastructure/src/sqlite/phase-repository.ts:12`   | `/** Used directly by compose.ts — no port type exists in @ai-sdlc/application. */` | Documentation-only — no port type exists    |
| `packages/infrastructure/src/sqlite/artifact-repository.ts:4` | `/** Used directly by compose.ts — no port type exists in @ai-sdlc/application. */` | Documentation-only — no port type exists    |
| `packages/infrastructure/src/bash/run-bash-script.ts:20`      | `/** Implements RunBashScriptFn (@ai-sdlc/application). */`                         | Above `export async function runBashScript` |

`PhaseRepository` and `ArtifactRepository` got JSDoc annotations but **no
conformance test** — the `StartIssueRun` use case uses them directly via
`Deps`, not through a port. There is no `PhaseRepositoryPort` or
`ArtifactRepositoryPort` in the application layer.

### Port alignment results

All four conformance tests **passed on the first attempt** — no port type
adjustments were needed in `packages/application/src/ports.ts`. The structural
typing already matched. This confirms that M1's adapter shapes were compatible
with M3's port declarations.

## Key design decisions

### 1. Test at the composition root, not on the adapter

Putting the conformance test in `apps/api` avoids any new cross-layer
dependency. It reuses the existing import graph — `apps/api` is the only
package that already depends on both `@ai-sdlc/application` and
`@ai-sdlc/infrastructure`.

**Alternative considered:** Move port types to `@ai-sdlc/domain` (which infra
already imports), allowing `implements` clauses directly on the infra classes.
Rejected because port ownership is consumer-side (application), and moving
them would cross M3 scope boundaries. Remains a valid future refactor.

### 2. `expectTypeOf` over discarded-type-alias pattern

`expectTypeOf<X>().toMatchTypeOf<Y>()` produces readable vitest failure
messages and integrates with the test runner. A discarded type alias
(`const _check: Y = {} as X`) would also work at compile time but produces
less readable output and can't be discovered by `pnpm test --run`.

**Fallback:** If `expectTypeOf` were unavailable (e.g., vitest version
mismatch), the discarded-type-alias pattern would work in any TypeScript
project.

### 3. Fix ports, not adapters

If a conformance assertion fails, the fix goes into the **port** in
`packages/application/src/ports.ts` — because the adapter is the existing,
working implementation. The application owns the interface; the port must fit
the adapter.

### 4. No behavioral changes

All infra changes are JSDoc-only — no code paths are altered. The test file
is additive. Zero risk of regression.

## Gotchas and pitfalls

### Duplicated `RunRecord` type

`RunRecord` is defined in **both** `packages/infrastructure/src/sqlite/run-repository.ts`
and `packages/application/src/ports.ts`. These are structurally identical
today but could drift. The infra version extends the domain `Run` with
`exitCode`, `durationMs`, `pid`. The application version has the same fields
but also adds `uuid`, `displayId`, `issueNumber`, `type`, `status`,
`completedPhases`, `startedAt`, `completedAt`, `failureReason`,
`currentPhase` — all from the domain `Run`. The duplication is required by the
layer boundary; there is a `NOTE` comment in both files warning they must stay
in sync.

The conformance test will catch drift because `RunRepository.findByUuid()`
returns the infra's `RunRecord` and the port expects the application's
`RunRecord`. If one drifts structurally, the `expectTypeOf` assertion will
fail.

### `runBashScript` has its own input/result type definitions

The infra file `run-bash-script.ts` defines its own `RunBashScriptInput` and
`RunBashScriptResult` interfaces that mirror the ones in
`packages/application/src/ports.ts`. The conformance test checks the function
signature (`typeof runBashScript` matches `RunBashScriptFn`), which is
adequate because the input/result types are structurally identical. If the
infra's input type drifts, callers passing port-typed args in `compose.ts`
will get a compile error.

### Zero runtime coverage

The conformance tests are typecheck-only — vitest strips `expectTypeOf` at
runtime, so they cost nothing. But they also catch nothing at runtime.
Behavioral drift (e.g., `insert()` starts throwing on valid input) requires
existing integration tests (`compose.test.ts`, etc.) to catch it.

### `expectTypeOf` is import-time only

`expectTypeOf` is a compile-time construct. The imports must use `import type`
for port types and regular `import` for adapter values. If you use
`import type` for the adapter class, you can't pass it to `expectTypeOf<X>()`
as a type argument — but vitest actually treats `expectTypeOf<X>()` as a type
parameter, so `import type { RunRepository }` works fine here. The exception
is `runBashScript` where we need `typeof runBashScript`, which requires a
value import.

## What someone needs to know to modify this code

### Adding a new conformance test

1. Import the port type from `@ai-sdlc/application` (use `import type`).
2. Import the adapter value/type from `@ai-sdlc/infrastructure`.
3. Add an `it(...)` block with `expectTypeOf<Adapter>().toMatchTypeOf<Port>()`.
4. Add a JSDoc `/** Implements <PortName> (@ai-sdlc/application). */` above
   the adapter's export in the infra package.

### When a conformance test fails

1. **Do NOT modify the infra adapter to match the port.** The port is wrong.
2. Compare the adapter's public method signatures against the port interface
   in `packages/application/src/ports.ts`.
3. Adjust the port type to match the adapter's actual shape.
4. Re-run: `pnpm --filter @ai-sdlc/api test --run port-conformance`.

### When adding a port for PhaseRepository or ArtifactRepository

If a future story adds `PhaseRepositoryPort` or `ArtifactRepositoryPort` to
the application layer:

1. Change the JSDoc from `"Used directly by compose.ts..."` to
   `"Implements <PortName> (@ai-sdlc/application)."`.
2. Add a conformance test case in `port-conformance.test.ts`.
3. Update this document.

### Verification commands

```bash
pnpm --filter @ai-sdlc/api test --run port-conformance  # 4 conformance assertions
pnpm --filter @ai-sdlc/api test --run                    # all API tests (no regressions)
pnpm depcruise                                           # layer boundary check
pnpm -r typecheck                                        # full workspace typecheck
pnpm lint                                                # linting
```

## Related

- Issue: [#72](https://github.com/opsclawd/automation/issues/72)
- Layer boundaries documented in `AGENTS.md` (inward-only rule)
- Ports defined in `packages/application/src/ports.ts`
- Composition root at `apps/api/src/compose.ts`
