---
title: Runtime-agnostic Agent Invocation types (M3-07)
date: 2026-05-20
category: domain
module: packages/application
problem_type: new_feature
component: agent_invocation
tags:
  - agent
  - invocation
  - agent-port
  - adr-0007
  - branded-types
  - layer-boundary
  - m3-06-dependency
---

# Runtime-agnostic Agent Invocation types (M3-07)

## Problem

The orchestrator needs a common language to describe "run an AI agent and get its result back" without caring which agent runtime (OpenCode, Pi) actually executes the invocation. Today, all agent execution is hardcoded to OpenCode. ADR-0007 introduces a runtime-agnostic `AgentPort` in M3-06, but that port requires request/result types to carry data across its boundary. Those types did not exist.

Per the milestone dependency graph, M3-07 (these types) must land **before** M3-06 (`AgentPort`), even though the milestone-stories document lists them in the opposite order.

## Design decisions and trade-offs

### 1. Pure data types in `application` layer, not `domain`

`AgentInvocationRequest` and `AgentInvocationResult` live in `packages/application/src/agent/invocation.ts` rather than in `@ai-sdlc/domain`. The types know about prompts and working directories, which would create a circular-feeling dependency if placed in the domain layer.

**Trade-off considered:** Placing these in `@ai-sdlc/domain`. Rejected because domain knowing about prompts and cwds is architecturally muddy. Keeping them in `application` avoids this while still keeping infrastructure (serialization, DB, runtime adapters) out of the types.

### 2. Branded types via runtime-validating constructors, not Zod

`AgentProfileName` is a branded string (`string & { readonly __brand: 'AgentProfileName' }`) with a `function AgentProfileName(v: string): AgentProfileName` constructor that validates non-empty and non-whitespace values. Matches the existing branded-ID pattern in `packages/domain/src/ids.ts` (`RunId`, `WorkerId`, etc.).

**Trade-off considered:** Using Zod for runtime validation. Rejected because these are already-pure types that cross no trust boundary. The branded-constructor pattern is simpler and consistent with the rest of M3.

### 3. `runId`, `repoId`, `workerId`, `stepId` are plain strings, not branded IDs

The issue spec keeps these as plain `string` (with `workerId` and `stepId` optional). This is deliberate — these types live at the application layer where strings are acceptable for routing/lookup. Branded IDs from the domain layer would create an unnecessary dependency on `@ai-sdlc/domain`.

### 4. `AgentInvocationOutcome` is a union type, not an enum

```typescript
type AgentInvocationOutcome = 'success' | 'failed' | 'timeout' | 'contract_violation';
```

Consistent with the codebase's existing style (`RunStatus`, `JobStatus`, `WorkerStatus` in the domain package). Enums add runtime overhead and a wider type-surface for no benefit.

### 5. M3-06 types temporarily inlined

`AgentProfileName` and `AgentRuntimeKind` belong to M3-06 (`agent/types.ts`), which hasn't landed yet. They are temporarily inlined in `invocation.ts` with clear delimiters:

```typescript
// TEMPORARY INLINE: These types belong to M3-06 (agent/types.ts).
// Once M3-06 lands, delete these inlines and import from './types.js'.
export type AgentRuntimeKind = 'opencode' | 'pi';
export type AgentProfileName = string & { readonly __brand: 'AgentProfileName' };
export function AgentProfileName(v: string): AgentProfileName { ... }
// END INLINE
```

When M3-06 lands, remove the inline block and add the import from `./types.js`.

## Implementation architecture

```
packages/application/src/
  ├── agent/
  │   └── invocation.ts              — AgentInvocationRequest, AgentInvocationResult, AgentInvocationOutcome
  ├── __tests__/
  │   └── agent-invocation.test.ts   — 10 tests: construction, outcomes, re-exports, brand validation
  ├── index.ts                       — added export * from './agent/invocation.js'
```

## Key implementation details

### 1. `AgentInvocationRequest` fields

| Field               | Type               | Required | Purpose                                           |
| ------------------- | ------------------ | -------- | ------------------------------------------------- |
| `profile`           | `AgentProfileName` | yes      | Which agent profile to use                        |
| `promptPath`        | `string`           | yes      | Path to the prompt file                           |
| `expectedArtifacts` | `string[]`         | yes      | Filenames the agent must produce (contract check) |
| `cwd`               | `string`           | yes      | Working directory the agent executes in           |
| `runId`             | `string`           | yes      | Orchestrator run UUID (plain string)              |
| `repoId`            | `string`           | yes      | Repository ID (plain string)                      |
| `workerId`          | `string`           | optional | The worker executing this invocation              |
| `phaseId`           | `string`           | yes      | Current phase name                                |
| `stepId`            | `string`           | optional | Current step within the phase                     |

### 2. `AgentInvocationResult` fields

| Field                | Type                     | Required | Purpose                                                  |
| -------------------- | ------------------------ | -------- | -------------------------------------------------------- |
| `runtime`            | `AgentRuntimeKind`       | yes      | Which runtime actually executed (`'opencode'` \| `'pi'`) |
| `provider`           | `string`                 | yes      | AI provider (e.g. `'anthropic'`)                         |
| `model`              | `string`                 | yes      | Model identifier                                         |
| `exitCode`           | `number`                 | yes      | Process exit code                                        |
| `durationMs`         | `number`                 | yes      | Wall-clock execution time                                |
| `stdoutPath`         | `string`                 | yes      | Path to captured stdout log                              |
| `stderrPath`         | `string`                 | yes      | Path to captured stderr log                              |
| `resultJsonPath`     | `string`                 | optional | Path to structured result JSON                           |
| `contractViolations` | `string[]`               | yes      | List of contract violations (empty = clean)              |
| `outcome`            | `AgentInvocationOutcome` | yes      | High-level outcome classification                        |

### 3. `AgentInvocationOutcome` values

- `'success'` — Agent completed successfully, all contracts satisfied
- `'failed'` — Agent failed (non-zero exit, crash, etc.)
- `'timeout'` — Agent exceeded its time budget
- `'contract_violation'` — Agent ran but violated contract (missing artifacts, etc.)

### 4. `AgentProfileName` brand constructor enforces trimmed non-empty

The constructor in `invocation.ts:7-9` uses `v.trim().length === 0` to reject both empty strings and whitespace-only strings. This was changed from `v.length === 0` (initial commit) in response to a code review finding — whitespace-only profile names are semantically empty and should be rejected.

### 5. Package entry point re-export

`packages/application/src/index.ts` includes `export * from './agent/invocation.js'`, making all types importable from `@ai-sdlc/application`. The test file validates this with a second import path (`from '../index.js'`) to catch regressions.

### 6. Zero cross-package dependencies

`invocation.ts` imports nothing from outside its own file — all types are either defined inline or are primitive. This ensures `pnpm depcruise` passes with no layer violations.

## Gotchas and pitfalls

### 1. M3-07 must land before M3-06 (opposite of milestone doc ordering)

The milestone-stories doc lists M3-07 after M3-06, but the dependency graph requires M3-07 first — `AgentPort` needs these types to exist. The `agent/` directory doesn't exist before M3-07 creates `invocation.ts`, so M3-06 cannot import from `./types.js` until M3-07 establishes the convention of placing agent types under `packages/application/src/agent/`.

### 2. Inline types must be removed when M3-06 lands

The inline `AgentRuntimeKind`, `AgentProfileName` type, and `AgentProfileName` constructor are temporary. When the M3-06 PR is authored, it must:

1. Delete the inline block in `invocation.ts` (lines 1-11)
2. Add `import { type AgentRuntimeKind, type AgentProfileName, AgentProfileName } from './types.js';`
3. Verify all tests still pass

Failure to remove the inline block will result in conflicting type definitions if M3-06's `types.ts` defines them differently.

### 3. `AgentProfileName` dual identity (type + function)

`AgentProfileName` is both a type (branded string) and a function (runtime constructor). This matches the pattern in `packages/domain/src/ids.ts`. When importing from `./types.js` after M3-06 lands, both the type and the value import are needed:

```typescript
import { type AgentProfileName, AgentProfileName } from './types.js';
```

This is handled cleanly by TypeScript's type/value import syntax but can be confusing if you only import one.

### 4. Whitespace validation was a review finding

The initial implementation only checked `v.length === 0`, which allowed whitespace-only strings like `'   '` to pass validation. Code review flagged this: a profile name of all spaces is semantically empty. Fixed by changing to `v.trim().length === 0` and updating the error message from `'must be non-empty'` to `'must be a non-empty string'`.

### 5. The `agent/` module boundary

`invocation.ts` creates the `packages/application/src/agent/` directory. Future agent-related files (M3-06's `types.ts`, the `AgentPort` interface, the `FakeAgentPort`, and runtime adapters) will all live under this directory. Any import from outside `packages/application/` is a layer violation — domain types must be imported via `@ai-sdlc/domain`, not relative paths.

## What to know before modifying this code

### Adding a new field to `AgentInvocationRequest` or `AgentInvocationResult`

1. Add the field to the interface in `packages/application/src/agent/invocation.ts`
2. Update the `AgentProfileName` brand test and the construction tests in `packages/application/src/__tests__/agent-invocation.test.ts`
3. Run tests: `pnpm --filter @ai-sdlc/application test -- --run`
4. Run depcruise: `pnpm depcruise`

### Adding a new outcome to `AgentInvocationOutcome`

1. Add the string literal to the union type in `invocation.ts:13`
2. Update the `outcomes` array in the test at `agent-invocation.test.ts:91-97`
3. Every `switch`/`if` consuming `outcome` will get a type-check error on the unhandled case — this is the benefit of union types

### Removing the M3-06 inline types

When M3-06 (`agent/types.ts`) lands:

1. Delete the `// TEMPORARY INLINE` block in `invocation.ts` (lines 1-11)
2. Add: `import { type AgentRuntimeKind, type AgentProfileName, AgentProfileName } from './types.js';`
3. Verify the types exportable from `./types.js` match exactly (same brand structure, same runtime union values)
4. Run `pnpm --filter @ai-sdlc/application test -- --run` and `pnpm depcruise`

### Layer boundary

`invocation.ts` imports nothing — all its types are self-contained (or inlined from M3-06). After M3-06 lands, it will import from `./types.js` only (same package, same `agent/` directory). No cross-package imports are allowed.

### Running verification

| What             | Command                                            |
| ---------------- | -------------------------------------------------- |
| Unit tests       | `pnpm --filter @ai-sdlc/application test -- --run` |
| Full test suite  | `pnpm -r test -- --run`                            |
| TypeScript check | `pnpm -r typecheck`                                |
| Lint             | `pnpm lint`                                        |
| Layer check      | `pnpm depcruise`                                   |

## Files changed

| File                                                          | Change                                                                                                                             |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `packages/application/src/agent/invocation.ts`                | New — `AgentInvocationRequest`, `AgentInvocationResult`, `AgentInvocationOutcome`, inlined `AgentProfileName` + `AgentRuntimeKind` |
| `packages/application/src/__tests__/agent-invocation.test.ts` | New — 10 tests covering construction, outcomes, package re-exports, brand validation                                               |
| `packages/application/src/index.ts`                           | Added `export * from './agent/invocation.js'`                                                                                      |
