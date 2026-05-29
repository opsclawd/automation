---
title: Ports-only infrastructure-to-application dependency rule
date: 2026-05-29
category: orchestrator
module: packages/application
problem_type: layer-boundary
component: ports
severity: high
symptoms:
  - depcruise had broad subtree exemptions for agent/, validation/, sqlite/ allowing those infra subtrees to import anything from application
  - The exemption encoded the wrong architectural rule — "these three subtrees can import all of application" instead of "infrastructure may only import port contracts"
  - PR #140 expanded the exemptions further to unblock M5-02, making the gap more acute
root_cause: port_adjacent_types_outside_ports
resolution_type: refactor
tags:
  - layer-boundary
  - ports
  - depcruise
  - dependency-inversion
  - hexagonal
related_components:
  - .dependency-cruiser.cjs
  - AGENTS.md
  - packages/application/src/ports/agent-invocation-types.ts
  - packages/application/src/ports/contract-violation-codes.ts
  - packages/application/src/ports/event-bus-port.ts
  - packages/application/src/ports/index.ts
  - packages/application/src/ports/agent-port.ts
  - packages/application/src/ports.ts
  - packages/application/src/index.ts
  - packages/application/package.json
---

# Ports-Only Infrastructure-to-Application Dependency Rule

## Problem

The monorepo follows a hexagonal/ports-and-adapters architecture: `packages/application` owns use cases and port contracts; `packages/infrastructure` implements adapters for those ports. The composition root in `apps/api/src/compose.ts` is the only legal cross-layer wiring point.

The `infrastructure-cannot-depend-on-application` rule in `.dependency-cruiser.cjs` was enforced via **broad subtree exemptions**:

```js
// OLD — wrong architecture encoded
{
  from: {
    path: '^packages/infrastructure/src',
    pathNot: [
      '^packages/infrastructure/src/agent/',
      '^packages/infrastructure/src/validation/',
      '^packages/infrastructure/src/sqlite/',
    ],
  },
  to: { path: '^packages/application' },
}
```

This exempted three entire subtrees from the ban, allowing them to import **anything** from `@ai-sdlc/application`. The exemptions existed because infrastructure adapters in those subtrees legitimately needed to import port-contract types like `AgentInvocationRequest`, `AgentInvocationResult`, and `CONTRACT_VIOLATION_CODES` — but those types lived in `packages/application/src/agent/` outside the `ports/` directory, so a naive "only allow `ports/`" rule would break valid imports.

The structural root cause: **port-adjacent types lived outside `ports/`**, which forced the depcruise rule to be overly permissive.

## Solution: Move Port-Adjacent Types + Tighten Depcruise Rule

### Part 1: Relocate types into `ports/`

Three files were moved or created:

| What | From | To | Contents |
|------|------|----|----------|
| Invocation types | `agent/invocation.ts` | `ports/agent-invocation-types.ts` | `AgentInvocationRequest`, `AgentInvocationResult`, `AgentInvocationOutcome` |
| Contract codes | `agent/contract-violation-codes.ts` | `ports/contract-violation-codes.ts` | `CONTRACT_VIOLATION_CODES` constant |
| Event bus port | inline in `ports.ts` | `ports/event-bus-port.ts` | `EventBusPort` interface (extracted to its own file for better organization) |

Key decisions made during the move:

**`AgentInvocationRequest` / `AgentInvocationResult` are port-contract types.** They define the adapter interface shapes — every agent adapter needs them. Moving them to `ports/` aligns the directory structure with the actual dependency pattern.

**`CONTRACT_VIOLATION_CODES` is a runtime constant, not a type.** Moving it to `ports/` is a semantic stretch — it's a constant, not an interface. But it is part of the adapter contract (infrastructure uses it to populate `contractViolations` arrays). The alternative was leaving it outside `ports/` and adding a specific depcruise exception, which adds complexity for no architectural gain. The pragmatic choice was to include it.

**The old files became re-export shims** during the transition (Task 3), then were **deleted** (Task 8) after all internal consumers were updated.

### Part 2: Add `@ai-sdlc/application/ports` package entry point

A new `ports/` sub-path export was added to `packages/application/package.json`:

```json
{
  "./ports": {
    "development": "./src/ports/index.ts",
    "types": "./dist/ports/index.d.ts",
    "import": "./dist/ports/index.js"
  }
}
```

This required creating `packages/application/src/ports/index.ts` as a dedicated barrel:

```typescript
export * from '../ports.js';
export type { AgentRuntimeKind } from '@ai-sdlc/domain';
```

The `AgentRuntimeKind` re-export is necessary because `agent-invocation-types.ts` imports it from `@ai-sdlc/domain` but does not re-export it through the application-level barrel — infrastructure files that need it (e.g., `opencode-adapter.ts`) import it from `@ai-sdlc/domain` directly.

### Part 3: Replace depcruise rules

Two new rules replaced the old single rule:

**Production code rule** — allows only `ports/`:
```js
{
  name: 'infrastructure-may-only-import-application-ports',
  severity: 'error',
  from: {
    path: '^packages/infrastructure/src',
    pathNot: ['(^|/)__tests__/'],
  },
  to: {
    path: '^packages/application/src',
    pathNot: ['^packages/application/src/ports/'],
  },
}
```

**Test code rule** — allows ports + test-doubles:
```js
{
  name: 'infrastructure-tests-may-use-application-ports-and-test-doubles',
  severity: 'error',
  from: { path: '^packages/infrastructure/src/.*/__tests__/' },
  to: {
    path: '^packages/application/src',
    pathNot: ['^packages/application/src/ports/', '^packages/application/src/test-doubles/'],
  },
}
```

### Part 4: Update AGENTS.md

The old rule `packages/infrastructure/**` MUST NOT import `@ai-sdlc/application` was replaced with the precise ports-only rule.

## Implementation Steps

The implementation followed an 11-task sequential plan (commits `b3cf47a..40405fa`):

1. **Create `ports/agent-invocation-types.ts`** — extracted from `agent/invocation.ts`
2. **Create `ports/contract-violation-codes.ts`** — extracted from `agent/contract-violation-codes.ts`
3. **Redirect old files to re-export** — shims for backward compat during transition
4. **Update `ports/agent-port.ts`** — import from `./agent-invocation-types.js` instead of `../agent/invocation.js`
5. **Update `ports.ts` barrel** — add re-exports from new locations
6. **Update `index.ts` barrel** — point exports to `ports/agent-invocation-types.ts` and `ports/contract-violation-codes.ts`
7. **Update application-internal consumers** — 6 files that imported directly from `agent/invocation.js` or `agent/contract-violation-codes.js`
8. **Remove re-export shims** — delete `agent/invocation.ts` and `agent/contract-violation-codes.ts`
9. **Update `.dependency-cruiser.cjs`** — the core depcruise rule change (4 review loops — the most complex task)
10. **Update `AGENTS.md`** — reflect the real rule
11. **Final validation** — `pnpm depcruise`, `pnpm -r typecheck`, `pnpm -r test`, `pnpm lint`

Additionally, `EventBusPort` was extracted from inline in `ports.ts` to its own file `ports/event-bus-port.ts` as part of Task 9, and `remult` was removed from the `package.json` dependencies (it was unused).

## Gotchas, Pitfalls, and Lessons Learned

### 1. Depcruise resolves barrel imports to source files

This is the most important gotcha. When infrastructure code does:

```typescript
import { AgentPort } from '@ai-sdlc/application';
```

depcruise follows the barrel chain (`index.ts` → `ports.ts` → `ports/agent-port.ts`) and checks the rule against the **resolved source path** (`packages/application/src/ports/agent-port.ts`), not the barrel re-export. This is correct behavior and the reason the ports-only rule works — depcruise sees the resolved path ending in `ports/agent-port.ts`, which passes the `pathNot` (it's inside `ports/`).

**But:** if the barrel chain ever adds a non-port re-export, infrastructure could transitively import application implementation code even though the source-level import statement looks like `from '@ai-sdlc/application'`. The depcruise rule would catch this because it would resolve to a non-port source path.

### 2. The `infrastructure-cannot-import-use-cases-via-barrel` rule was unnecessary

In the first attempt of Task 9, an additional rule was added:

```js
{
  name: 'infrastructure-cannot-import-use-cases-via-barrel',
  to: { path: '^packages/application/src/(start-issue-run|cancel-run|...)', },
}
```

This was redundant — the `infrastructure-may-only-import-application-ports` rule already catches all these via the ports-only `pathNot`. The explicit deny rule was removed in review loop 4, simplifying the config.

### 3. `AgentRuntimeKind` re-export in `ports/index.ts`

`ports/agent-invocation-types.ts` imports `AgentRuntimeKind` from `@ai-sdlc/domain` — it was originally re-exported through `agent/types.ts`. After the move, `ports/index.ts` needs to explicitly re-export it so that infrastructure files importing it from `@ai-sdlc/application/ports` or transitively through `@ai-sdlc/application` can still resolve it.

### 4. Infrastructure test imports from `@ai-sdlc/application/test-doubles`

Infrastructure test files import test doubles like `FakeAgentInvocationPort` from `@ai-sdlc/application/test-doubles`. Depcruise's test rule allows this. The key distinction: depcruise tests the `from` path against the rule's `from` pattern. Infrastructure test files (`*/__tests__/*`) match the test-specific rule, not the production rule, because the production rule excludes `__tests__/` via `pathNot`.

### 5. `remult` dependency removal

During the review process, `remult` was identified as an unused transitive dependency in `packages/application/package.json`. It was removed as a drive-by cleanup. This is a good reminder: when updating package.json for a structural change, look for dead dependencies to remove.

### 6. Four review loops on the depcruise rule

Task 9 went through 4 review loops — the most iterative of the 11 tasks. The issues found were:

- **Loop 1:** The initial ports-only rule was too narrow — didn't account for infrastructure test files that need to import test doubles
- **Loop 2:** Added an unnecessary explicit deny list of use-case files (reviewed out in loop 3)
- **Loop 3:** Removed the explicit deny rule but the test-doubles rule hadn't been verified against real imports yet (infra test files use `describe.each` in paths like `__tests__/router-fallback.test.ts` which matches the `.*/__tests__/` pattern)
- **Loop 4:** Final cleanup — `EventBusPort` was extracted to its own file, `remult` removed, and a `packages/application/src/ports/index.ts` file was created for the `@ai-sdlc/application/ports` entry point

Lesson: **The depcruise rule is the enforcement boundary for the entire architecture.** Getting it right matters and requires tracing actual import resolution through the barrel chain. Run `pnpm depcruise` early and often.

### 7. The `ports/index.ts` barrel's `export * from '../ports.js'` is intentional but fragile

`ports/index.ts` uses `export * from '../ports.js'` to avoid duplicating all port exports. This means `@ai-sdlc/application/ports` exposes everything that `packages/application/src/ports.ts` exposes. If a non-port type is added to `ports.ts`, it becomes available through the `/ports` entry point. The depcruise rule would still block infrastructure from importing it through the source path, but it widens the surface area — future maintainers should be aware of this re-export chain.

## File Inventory

| File | Purpose |
|------|---------|
| `.dependency-cruiser.cjs` | Two new rules replacing the old broad-exemption rule |
| `AGENTS.md` | Updated layer boundary prose matching actual enforcement |
| `packages/application/src/ports/agent-invocation-types.ts` | Moved invocation request/result/outcome types |
| `packages/application/src/ports/contract-violation-codes.ts` | Moved CONTRACT_VIOLATION_CODES constant |
| `packages/application/src/ports/event-bus-port.ts` | Extracted EventBusPort interface to own file |
| `packages/application/src/ports/index.ts` | Barrel for @ai-sdlc/application/ports entry point |
| `packages/application/src/ports/agent-port.ts` | Updated to import from `./agent-invocation-types.js` |
| `packages/application/src/ports.ts` | Added re-exports from new port files |
| `packages/application/src/index.ts` | Pointed barrel exports to ports/ locations |
| `packages/application/package.json` | Added `./ports` sub-path export |

Deleted files: `packages/application/src/agent/invocation.ts`, `packages/application/src/agent/contract-violation-codes.ts`

## How to Modify This Code

1. **Adding a new port type.** If you're adding a type that infrastructure adapters need, put it in `packages/application/src/ports/`. If it belongs in a new file (e.g., `ports/foo-port-types.ts`), add it there and update `ports.ts` to re-export.

2. **Adding a new export to `@ai-sdlc/application/ports`.** The entry point is `packages/application/src/ports/index.ts`. It re-exports from `../ports.js` (the main barrel). If your new port needs a type from `@ai-sdlc/domain` that isn't currently re-exported, add it to `ports/index.ts`.

3. **If depcruise fails for an infrastructure file.** First check: is the import resolving to a path inside `packages/application/src/ports/`? If yes, investigate the barrel resolution chain — depcruise should be seeing the final source file. If the import resolves to a non-port path, it's either (a) a non-port type that should be moved into `ports/`, or (b) a genuine layer violation that should be restructured.

4. **If an infrastructure test needs to import a test double.** Add the re-export to the appropriate test-doubles barrel file. The depcruise test rule allows `test-doubles/` for infrastructure `__tests__/` files.

## Validation

```bash
pnpm depcruise          # ports-only rule enforcement
pnpm -r typecheck       # type safety after moves
pnpm -r test            # runtime correctness
pnpm lint                # style compliance
```

## Related

- Issue #141 — this issue
- PR #140 — the PR that temporarily broadened the exceptions
- `docs/solutions/orchestrator/port-injection-pattern-2026-05-18.md` — the canonical port injection pattern
- `docs/solutions/orchestrator/per-command-validation-adapter-2026-05-29.md` — validation adapter that motivated the ports-only enforcement
