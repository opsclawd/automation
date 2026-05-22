---
title: Branded ID types and waiting state transitions — M3-01 domain foundation
date: 2026-05-20
category: domain
module: packages/domain
problem_type: domain_modeling
component: ids
symptoms:
  - Runtime type errors from passing wrong identifier type
  - No compile-time protection against IssueNumber used where RepositoryId expected
root_cause: missing_branded_types
resolution_type: new_feature
severity: medium
related_components:
  - packages/domain/src/ids.ts
  - packages/domain/src/run.ts
tags:
  - branded-types
  - domain
  - state-machine
  - run-state
---

# Branded ID Types and Waiting State Transitions — M3-01 Domain Foundation

## Branded Type Idiom

```typescript
// packages/domain/src/ids.ts

export type RunId = string & { readonly __brand: 'RunId' };
export type IssueNumber = number & { readonly __brand: 'IssueNumber' };
export type PhaseName = string & { readonly __brand: 'PhaseName' };
export type RepositoryId = string & { readonly __brand: 'RepositoryId' };
export type JobId = string & { readonly __brand: 'JobId' };
export type WorkerId = string & { readonly __brand: 'WorkerId' };
```

Intersection type with phantom `__brand` — exists only at type level, no runtime artifact. Catches misassignments at compile time.

### Constructor pattern with validation

```typescript
export function RunId(v: string): RunId {
  if (!v) throw new Error('RunId: empty string');
  return v as RunId;
}

export function IssueNumber(v: number): IssueNumber {
  if (!Number.isInteger(v) || v <= 0) {
    throw new Error(`IssueNumber: must be positive integer, got ${v}`);
  }
  return v as IssueNumber;
}
```

Constructors throw on invalid input. Consistency with existing `RunStateError` pattern — callers already handle errors from state transitions.

## Why Not Wrapper Objects?

Branded wrapper objects (`class RunId { constructor(public readonly value: string) {} }`) were rejected because:

- Require `.value` access everywhere
- Complicate serialization
- Break existing `Run` interface which uses raw `string` for `uuid`

The intersection idiom costs nothing at runtime and preserves existing code patterns.

## Waiting State Transitions

### `transitionToReady`

```typescript
// packages/domain/src/run.ts

export function transitionToReady(run: Run): Run {
  if (run.currentPhase !== undefined) {
    throw new RunStateError(
      `cannot transition ${run.displayId} to ready: currentPhase '${run.currentPhase}' still set`,
    );
  }
  if (TERMINAL_STATUSES.has(run.status)) {
    throw new RunStateError(`cannot transition ${run.displayId} to ready: run is ${run.status}`);
  }
  return { ...run, status: 'waiting' };
}
```

Preconditions:

- `currentPhase === undefined` — cannot rest mid-phase
- Status not terminal — cannot transition from passed/failed/cancelled

### `reactivate`

```typescript
export function reactivate(run: Run): Run {
  if (run.status !== 'waiting') {
    throw new RunStateError(
      `cannot reactivate ${run.displayId}: status is '${run.status}', expected 'waiting'`,
    );
  }
  return { ...run, status: 'running' };
}
```

Precondition: `status === 'waiting'`. Does not re-check `currentPhase` because `transitionToReady` enforces `currentPhase === undefined` before setting `status = 'waiting'`.

## Transition Matrix (Relevant Entries)

| Transition          | Precondition                                         | Postcondition        |
| ------------------- | ---------------------------------------------------- | -------------------- |
| `transitionToReady` | `currentPhase === undefined` AND status not terminal | `status = 'waiting'` |
| `reactivate`        | `status === 'waiting'`                               | `status = 'running'` |
| `passRun`           | (existing)                                           | `status = 'passed'`  |
| `failRun`           | (existing)                                           | `status = 'failed'`  |

Terminal statuses: `'passed'`, `'failed'`, `'cancelled'`.

## Property Test with fast-check

```typescript
// packages/domain/src/__tests__/run-transitions.test.ts

import { fc } from 'fast-check';

it('passRun throws when called mid-phase', () => {
  fc.assert(
    fc.property(fc.string(), fc.string(), (displayId, phase) => {
      const run = createRun({ displayId, currentPhase: phase });
      expect(() => passRun(run, new Date())).toThrow(RunStateError);
    }),
  );
});
```

Validates that `passRun` throws when `currentPhase` is set — the invariant was implicitly tested by example-based tests, but the property test covers the unbounded space of phase names.

## Known Gaps

1. **`currentPhase` on `Run` is still `string`, not `PhaseName`** — `transitionToReady` checks at runtime, not compile time. Future migration will change `currentPhase?: string` to `currentPhase?: PhaseName`.

2. **`waiting` → terminal transition missing** — global timeout should eventually transition waiting Run to `cancelled`. Not implemented yet.

3. **`reactivate` does not clear `completedAt`** — if `completedAt` was set before `transitionToReady`, it persists. No enforcement that `completedAt` is terminal-only.

## File Layout

| File                                                    | Purpose                                                           |
| ------------------------------------------------------- | ----------------------------------------------------------------- |
| `packages/domain/src/ids.ts`                            | Six branded type definitions and constructors                     |
| `packages/domain/src/run.ts`                            | `transitionToReady` and `reactivate` added after existing exports |
| `packages/domain/src/index.ts`                          | `export * from './ids.js'`                                        |
| `packages/domain/src/__tests__/ids.test.ts`             | Constructor tests                                                 |
| `packages/domain/src/__tests__/run-transitions.test.ts` | Transition tests + fast-check property test                       |

## Export Summary

```typescript
// types
(RunId, IssueNumber, PhaseName, RepositoryId, JobId, WorkerId);

// functions
(createRun, startPhase, completePhase, passRun, failRun, cancelRun);
(transitionToReady, reactivate);

// exceptions
RunStateError;
```
