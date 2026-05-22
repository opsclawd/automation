---
title: Repository domain type and RepositoryPort (M3-02)
date: 2026-05-20
category: domain
module: packages/domain, packages/application
problem_type: new_feature
component: repository
symptoms:
  - No first-class Repository domain type — only raw owner/name strings
  - No way to refuse a run for an unknown or disabled repository
  - Run-creation paths cannot validate RepositoryId against a registry
root_cause: missing_domain_concept
resolution_type: new_feature
severity: medium
related_components:
  - packages/domain/src/repository.ts
  - packages/application/src/ports.ts
  - packages/application/src/test-doubles/fake-repository-port.ts
tags:
  - domain-type
  - repository-port
  - fake-repository
  - invariant-0a
  - adr-0008
  - m3-02
  - layer-boundary
---

# Repository domain type and `RepositoryPort` (M3-02)

## Problem

The orchestrator must enforce that runs start only against approved/registered repositories (PRD invariant 0a, ADR-0008). The codebase lacked a first-class `Repository` domain concept — only raw `owner/name` strings. Two concrete problems:

1. **No type-safe repo reference** — use cases accepting a `RepositoryId` had no domain object to work with.
2. **No approval gate** — no mechanism to refuse a run for an unknown or disabled repository.

ADR-0008 introduced single-tenant VPS deployment where runs start against a small set of operator-approved repositories.

## Solution

### Domain type (`packages/domain/src/repository.ts`)

```typescript
export interface Repository {
  id: RepositoryId;
  owner: string;
  name: string;
  fullName: string; // "owner/name"
  defaultBranch: string;
  localBasePath: string; // e.g. /var/lib/repos/owner__name
  enabled: boolean;
  maxConcurrentRuns: 1; // literal type — ADR-0008 invariant
  createdAt: Date;
  updatedAt: Date;
}
```

`maxConcurrentRuns: 1` is a **literal type** — any code attempting to assign a different value gets a compile error. This is a type-level enforcement of ADR-0008's "never more than one Worker against the same Repository at the same time" invariant.

### Domain error (`packages/domain/src/repository.ts`)

```typescript
export class RepositoryNotApprovedError extends Error {
  readonly repositoryId: RepositoryId;
  constructor(repositoryId: RepositoryId) {
    super(`Repository ${repositoryId} is not approved/registered or is disabled`);
    this.name = 'RepositoryNotApprovedError';
    this.repositoryId = repositoryId;
  }
}
```

### Port interface (`packages/application/src/ports.ts:107-111`)

```typescript
export interface RepositoryPort {
  findById(id: RepositoryId): Repository | undefined;
  findByFullName(fullName: string): Repository | undefined;
  listEnabled(): Repository[];
}
```

Three methods covering the query surface needed for run-approval gating. Defined directly in `ports.ts` (not a separate file), following the existing convention for small ports.

### Fake (`packages/application/src/test-doubles/fake-repository-port.ts`)

In-memory `Map<RepositoryId, Repository>` backed implementation seeded via constructor. Exported from `test-doubles/index.ts`.

## Key design decisions

### `maxConcurrentRuns: 1` literal type

Enforces ADR-0008's invariant at the type level. A future developer cannot accidentally set `maxConcurrentRuns` to anything else without a compile error. Tests must use `as const` when spreading partial objects to preserve the literal type.

### Port interface inlined into `ports.ts` (not a separate file)

The review found a separate port file was unnecessary indirection. All existing ports (`RunRepositoryPort`, `FailureRepositoryPort`, `JobQueuePort`, `WorkerRegistryPort`, `WorkerLeasePort`) are defined directly in `ports.ts`. A separate file broke the established pattern.

### `FakeRepositoryPort.add()` was removed as YAGNI

The initial implementation included an `add()` method not in the port interface. Removed during review — no use case calls it yet, and tests can seed through the constructor. If needed later, add `add()` back only when a real consumer requires it.

### `findByFullName` uses linear scan in the fake

The fake uses `for...of` over `Map.values()`. Acceptable for in-memory fake (small N). The SQLite adapter (M8) will have a database index on `fullName`.

## Gotchas and pitfalls

### `FakeRepositoryPort` imports from `../ports.js`, not a port-specific file

After the port was inlined into `ports.ts`, the import path in `fake-repository-port.ts` changed from `'../ports/repository-port.js'` to `'../ports.js'`. The port file `ports/repository-port.js` doesn't exist — always import from the barrel `ports.ts`.

### Layer boundary is enforced by CI

- `Repository` lives in `packages/domain` — may only import `@ai-sdlc/shared`
- `RepositoryPort` lives in `packages/application` — may import `@ai-sdlc/domain` but NOT `@ai-sdlc/infrastructure`
- `pnpm depcruise` catches violations

### `add()` was removed — don't restore without a use case

If you need to add repos to the fake dynamically, consider `new FakeRepositoryPort([...oldSeed, newRepo])` first. Only add `add()` back when a real consumer requires dynamic registration.

## File map

| File                                                              | Purpose                                               |
| ----------------------------------------------------------------- | ----------------------------------------------------- |
| `packages/domain/src/repository.ts`                               | `Repository` interface + `RepositoryNotApprovedError` |
| `packages/domain/src/index.ts`                                    | Barrel: `export * from './repository.js'`             |
| `packages/application/src/ports.ts:107-111`                       | `RepositoryPort` interface (inlined)                  |
| `packages/application/src/test-doubles/fake-repository-port.ts`   | `FakeRepositoryPort` — in-memory test double          |
| `packages/application/src/test-doubles/index.ts`                  | Barrel re-export                                      |
| `packages/domain/src/__tests__/repository.test.ts`                | Domain type tests (2 tests)                           |
| `packages/application/src/__tests__/fake-repository-port.test.ts` | Fake tests (5 tests)                                  |

## What to know before modifying this code

### Adding a new field to `Repository`

Update `packages/domain/src/repository.ts`. The `maxConcurrentRuns: 1` literal type requires `as const` in test spreads.

### Implementing the SQLite adapter (M8)

The adapter must enforce the `enabled` filter in all queries. `listEnabled()` should exclude disabled repos. `findById` and `findByFullName` should return `undefined` for disabled repos (not an error — the caller decides what to do with a disabled repo).

### Adding a new port method

Add the method to `RepositoryPort` in `ports.ts`, implement it in `FakeRepositoryPort`, and add both hit and miss test cases.

### Verification

```bash
pnpm --filter @ai-sdlc/domain test --run repository     # 2 tests
pnpm --filter @ai-sdlc/application test --run fake-repository-port  # 5 tests
pnpm -r typecheck && pnpm depcruise
```
