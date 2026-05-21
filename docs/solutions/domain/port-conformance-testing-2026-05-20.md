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
  - apps/api/src/port-conformance.check.ts
tags:
  - ports
  - ports-and-adapters
  - hexagonal-architecture
  - layer-boundaries
  - structural-typing
  - typecheck-only-tests
  - typecheck-file
  - discarded-variable-pattern
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
`@ai-sdlc/infrastructure`). Use a standalone `.check.ts` file with
discarded-variable assignments — `const _x: Port = null as unknown as Adapter` —
which TypeScript's structural type system validates at compile time via
`tsc --noEmit`. Unlike vitest's `expectTypeOf` (stripped by esbuild at build
time), these assertions survive the compilation pipeline and are enforced by
`pnpm -r typecheck`.

Add JSDoc annotations on each infra adapter export referencing its port, so a
reader looking only at the infra code can trace the contract. These are
documentation-only — no type-level effect, no new imports.

## Implementation

### Files created

- **`apps/api/src/port-conformance.check.ts`** — 4 discarded-variable
  assignments in a single file:

  | Assignment                                  | Adapter (infra)        | Port (application)      |
  | ------------------------------------------- | ---------------------- | ----------------------- |
  | `_runRepository: RunRepositoryPort`         | `RunRepository`        | `RunRepositoryPort`     |
  | `_eventRepository: EventRepositoryPort`     | `EventRepository`      | `EventRepositoryPort`   |
  | `_failureRepository: FailureRepositoryPort` | `FailureRepository`    | `FailureRepositoryPort` |
  | `_runBashScript: RunBashScriptFn`           | `typeof runBashScript` | `RunBashScriptFn`       |

  The file is added to the depcruise exemption list in
  `.dependency-cruiser.cjs` (already part of the composition root's import
  graph). It imports **types only** from both `@ai-sdlc/application` and
  `@ai-sdlc/infrastructure` — legal because `apps/api` depends on both.
  The file is picked up by `tsc --noEmit` because it lives under `apps/api/src`
  and is covered by the existing tsconfig.

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
conformance check** — the `StartIssueRun` use case uses them directly via
`Deps`, not through a port. There is no `PhaseRepositoryPort` or
`ArtifactRepositoryPort` in the application layer.

### Port alignment results

All four conformance checks **passed on the first attempt** — no port type
adjustments were needed in `packages/application/src/ports.ts`. The structural
typing already matched. This confirms that M1's adapter shapes were compatible
with M3's port declarations.

## Key design decisions

### 1. Check at the composition root, not on the adapter

Putting the conformance check in `apps/api` avoids any new cross-layer
dependency. It reuses the existing import graph — `apps/api` is the only
package that already depends on both `@ai-sdlc/application` and
`@ai-sdlc/infrastructure`.

**Alternative considered:** Move port types to `@ai-sdlc/domain` (which infra
already imports), allowing `implements` clauses directly on the infra classes.
Rejected because port ownership is consumer-side (application), and moving
them would cross M3 scope boundaries. Remains a valid future refactor.

### 2. Discarded-variable check file over vitest `expectTypeOf`

The initial implementation used vitest's `expectTypeOf<X>().toMatchTypeOf<Y>()`
in `apps/api/src/__tests__/port-conformance.test.ts`. However, vitest assertions
are stripped by esbuild at build time and are **not** checked by
`tsc --noEmit` — they only run during `pnpm test`. The discarded-variable
pattern (`const _x: Port = null as unknown as Adapter`) is checked by
`pnpm -r typecheck` and appears in every CI pipeline that runs typechecking,
not just the test suite. This provides stronger guarantees because the
assertions cannot be accidentally excluded from a CI step.

The `.check.ts` file convention mirrors TypeScript's own `.d.ts` convention:
a dedicated file type that signals "this file exists only for type-level
verification." It is exempted from depcruise (composition root imports both
layers by design) and added to the existing tsconfig.

### 3. Fix ports, not adapters

If a conformance assertion fails, the fix goes into the **port** in
`packages/application/src/ports.ts` — because the adapter is the existing,
working implementation. The application owns the interface; the port must fit
the adapter.

### 4. No behavioral changes

All infra changes are JSDoc-only — no code paths are altered. The check file
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

The conformance check will catch drift because `RunRepository.findByUuid()`
returns the infra's `RunRecord` and the port expects the application's
`RunRecord`. If one drifts structurally, the type assignment in the check
file will fail during `tsc --noEmit`.

### `runBashScript` has its own input/result type definitions

The infra file `run-bash-script.ts` defines its own `RunBashScriptInput` and
`RunBashScriptResult` interfaces that mirror the ones in
`packages/application/src/ports.ts`. The conformance check tests the function
signature (`typeof runBashScript` matches `RunBashScriptFn`), which is
adequate because the input/result types are structurally identical. If the
infra's input type drifts, callers passing port-typed args in `compose.ts`
will get a compile error.

### Zero runtime coverage

The conformance checks are typecheck-only — the discarded variables produce no
runtime code (they are never referenced). Behavioral drift (e.g., `insert()`
starts throwing on valid input) requires existing integration tests
(`compose.test.ts`, etc.) to catch it.

### All imports must be `import type`

Both port and adapter imports in the check file use `import type` exclusively
— no value-level imports are needed because the assignments only reference
types. This is valid because `apps/api` declares both `@ai-sdlc/application`
and `@ai-sdlc/infrastructure` as dependencies.

## What someone needs to know to modify this code

### Adding a new conformance check

1. Import the port type from `@ai-sdlc/application` (use `import type`).
2. Import the adapter type from `@ai-sdlc/infrastructure` (use `import type`).
3. Add a discarded-variable assignment:
   `// eslint-disable-next-line @typescript-eslint/no-unused-vars`
   `const _<name>: <PortType> = null as unknown as <AdapterType>;`
4. Add a JSDoc `/** Implements <PortName> (@ai-sdlc/application). */` above
   the adapter's export in the infra package.

### When a conformance check fails

1. **Do NOT modify the infra adapter to match the port.** The port is wrong.
2. Compare the adapter's public method signatures against the port interface
   in `packages/application/src/ports.ts`.
3. Adjust the port type to match the adapter's actual shape.
4. Re-run: `pnpm -r typecheck` (or just `pnpm --filter @ai-sdlc/api typecheck`).

### When adding a port for PhaseRepository or ArtifactRepository

If a future story adds `PhaseRepositoryPort` or `ArtifactRepositoryPort` to
the application layer:

1. Change the JSDoc from `"Used directly by compose.ts..."` to
   `"Implements <PortName> (@ai-sdlc/application)."`.
2. Add a conformance check case in `port-conformance.check.ts`.
3. Remove the depcruise exemption if the new port type is the only reason
   the check file needs it (otherwise keep it).
4. Update this document.

### Verification commands

```bash
pnpm -r typecheck                          # 4 conformance assignments checked by tsc
pnpm --filter @ai-sdlc/api test --run      # all API tests (no regressions)
pnpm depcruise                             # layer boundary check
pnpm lint                                  # linting
```

## Related

- Issue: [#72](https://github.com/opsclawd/automation/issues/72)
- Layer boundaries documented in `AGENTS.md` (inward-only rule)
- Ports defined in `packages/application/src/ports.ts`
- Composition root at `apps/api/src/compose.ts`
