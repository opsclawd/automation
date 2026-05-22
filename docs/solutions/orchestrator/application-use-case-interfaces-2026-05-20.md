---
title: Application use-case interfaces and non-agent infrastructure ports (M3-05)
date: 2026-05-20
category: orchestrator
module: packages/application
problem_type: interface_declaration
component: use_cases_and_ports
symptoms:
  - M4-M8 stories cannot compile against stable contracts
  - Every subsequent milestone would churn domain and application code as port signatures evolve
root_cause: missing_interface_contracts
resolution_type: new_feature
severity: medium
tags:
  - m3
  - ports
  - interfaces
  - use-cases
  - test-doubles
  - layer-boundary
  - github-port
  - git-port
  - validation-port
  - artifact-store
  - m3-05
---

# Application use-case interfaces and non-agent infrastructure ports (M3-05)

## Problem

The orchestrator had concrete use-case classes (`StartIssueRun`, `CancelRun`, `SweepOrphanedRuns`) but no formal interface contracts for the use cases M4-M8 would build against. M3 introduced a Job/Worker/Lease execution model (ADR-0008), requiring new use-case boundaries and new infrastructure ports (`GitHubPort`, `GitPort`, `ValidationPort`, `ArtifactStore`). Without declaring these as interfaces first, every subsequent milestone would churn domain and application code as signatures evolved.

The layer-boundary constraint (`application` MUST NOT import `infrastructure`) means concrete implementations of these ports live in `infrastructure` and are wired at the composition root (`apps/api/src/compose.ts`).

## Solution

### Use-case interfaces (`packages/application/src/use-cases.ts`)

Ten interface declarations, all following a single `execute(input: {...})` method pattern:

| Interface                        | Input                               | Output                   |
| -------------------------------- | ----------------------------------- | ------------------------ |
| `StartIssueRunUseCase`           | `{ repoId, issueNumber }`           | `{ runId, jobId }`       |
| `ResumeRunUseCase`               | `{ runId, fromPhase? }`             | `void`                   |
| `RetryFailedPhaseUseCase`        | `{ runId }`                         | `void`                   |
| `CancelRunUseCase`               | `{ runId, reason? }`                | `void`                   |
| `ClaimNextJobUseCase`            | `{ workerId }`                      | `{ jobId } \| undefined` |
| `AcquireRepoLeaseUseCase`        | `{ workerId, jobId }`               | `void`                   |
| `ReleaseRepoLeaseUseCase`        | `{ workerId, repoId }`              | `void`                   |
| `RunAgentWithContractUseCase`    | `{ runId, phaseName, profileName }` | `{ ok }`                 |
| `RunValidationUseCase`           | `{ runId }`                         | `{ ok }`                 |
| `ProcessPrReviewCommentsUseCase` | `{ runId }`                         | `{ processed }`          |
| `CreatePullRequestUseCase`       | `{ runId }`                         | `{ prUrl }`              |

### Port interfaces (`packages/application/src/ports/`)

Each port is in its own file, re-exported from `ports.ts`:

**`GitHubPort`** (`ports/github-port.ts`):

- 5 methods: `getIssue`, `createPullRequest`, `listReviewComments`, `replyToReviewComment`, `updateIssueLabels`
- 4 DTOs: `GitHubIssue`, `PullRequest`, `PrReviewComment`, `CreatePullRequestInput`

**`GitPort`** (`ports/git-port.ts`):

- 7 methods: `createWorktree`, `removeWorktree`, `currentBranch`, `headCommitSha`, `resetHard`, `diff`, `commit`, `push`
- 2 input DTOs: `CreateWorktreeInput`, `PushInput`

**`ValidationPort`** (`ports/validation-port.ts`):

- 1 method: `run(input)` → `ValidationCommandResult[]`

**`ArtifactStore`** (`ports/artifact-store.ts`):

- 3 methods: `write`, `read`, `list`
- Uses `string` for `runId` (not branded `RunId`) — consistent with `RunRecord.uuid: string`

### Fakes (`packages/application/src/test-doubles/`)

All fakes are in-memory implementations with mutable state for test setup:

| Fake                 | Backing store                                                         | Key behaviors                                                                         |
| -------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `FakeGitHubPort`     | `Map<string, GitHubIssue>` keyed by `"repoFullName/issueNumber"`      | `getIssue` throws on unknown keys; `listReviewComments` returns `[]` for unknown keys |
| `FakeGitPort`        | `Map<string, string>` for branch/SHA by `cwd`                         | `currentBranch`/`headCommitSha` throw on unknown `cwd`                                |
| `FakeValidationPort` | Single mutable `result: ValidationCommandResult[]`                    | `run()` always returns `this.result`                                                  |
| `FakeArtifactStore`  | `Map<string, { artifact, contents }>` keyed by `"runId/relativePath"` | `read` throws on unstubbed paths; handles both `string` and `Uint8Array`              |

All fakes throw on unstubbed lookups (not return `undefined`) — catches missing test setup immediately. Public collections are mutable so tests can set up state directly.

## Key design decisions

### Interface-only file separate from concrete classes

`use-cases.ts` contains only `interface` declarations — no classes, no function bodies. The existing concrete classes (`StartIssueRun`, `CancelRun`) live in their own files and export classes. A separate `use-cases.ts` makes the contract boundary explicit and allows M4-M8 imports to target `@ai-sdlc/application` without pulling in concrete class implementations.

### Each port gets its own file under `src/ports/`

Follows the existing convention (`job-queue-port.ts`, `worker-registry-port.ts`, `worker-lease-port.ts`). Individual files are easier to diff, test-double, and maintain than one giant file.

### Fakes throw on unstubbed lookups

Silent `undefined` propagates as cryptic runtime errors in tests. Throwing loudly surfaces missing stubs immediately. Matches the existing `FakeJobQueuePort` pattern.

### Smoke test imports every fake from the barrel

One test file (`test-doubles-smoke.test.ts`) instantiates every fake via `new` from `test-doubles/index.ts`. Catches missing exports, import path errors, and constructor signature changes.

## Gotchas and pitfalls

### `StartIssueRunUseCase.execute` return shape mismatch

Existing `StartIssueRun.execute` returns `{ uuid, displayId, exitCode, status }`. The new interface returns `{ runId, jobId }`. M8 must bridge this gap when wiring the concrete class to `implements StartIssueRunUseCase`.

### `ArtifactStore` uses `string` for `runId`, not branded `RunId`

Consistent with `RunRecord.uuid: string`. The branded `RunId` from domain is available but adds friction for a store receiving IDs from serialized events or API calls.

### Agent-adjacent use cases can't be instantiated yet

`RunAgentWithContractUseCase`, `RunValidationUseCase`, `ProcessPrReviewCommentsUseCase`, and `CreatePullRequestUseCase` exist as pure interfaces. Their first concrete implementation needs `AgentPort` (M3-06), `AgentInvocationRequest`/`Result` (M3-07), and `AgentRuntimeRouter` (M3-07).

### No rewiring of existing classes

`StartIssueRunUseCase` documents "Enqueues a Job; never executes the phase pipeline inline." The existing concrete `StartIssueRun` executes inline synchronously. The concrete class does **not** `implements StartIssueRunUseCase` yet — that's M8's concern.

## What to know before modifying this code

### Adding a new port

1. Create the port file in `packages/application/src/ports/<name>.ts`
2. Add `export type { ... }` in `packages/application/src/ports.ts`
3. Create a fake in `packages/application/src/test-doubles/fake-<name>-port.ts`
4. Add `export * from './fake-<name>-port.js'` in `test-doubles/index.ts`
5. Add instantiation in `test-doubles-smoke.test.ts`

### Adding a new use-case interface

1. Add the `interface` declaration in `packages/application/src/use-cases.ts`
2. It's automatically re-exported via `export * from './use-cases.js'` in `index.ts`
3. Use domain types (`RunId`, `JobId`, `WorkerId`, etc.) — not application or infrastructure types

### Testing with fakes

- Set up fake state before calling the code under test
- Lookup fakes throw by default — must stub before use
- Append-only collections (`repliesPosted`, `commits`, `pushes`) — assert on array length or specific entries after the operation
- `FakeArtifactStore` uses `Map` semantics — `read` throws if the path hasn't been `write`n first

## File map

```
packages/application/src/
  use-cases.ts                    — 11 use-case interface declarations
  index.ts                        — added export * from './use-cases.js'
  ports/
    github-port.ts                — GitHubPort + 4 DTOs
    git-port.ts                   — GitPort + 2 input DTOs
    validation-port.ts           — ValidationPort + 2 DTOs
    artifact-store.ts             — ArtifactStore + 2 DTOs
  ports.ts                        — re-exports for 4 new ports
  test-doubles/
    fake-github-port.ts           — in-memory fake
    fake-git-port.ts             — in-memory fake
    fake-validation-port.ts       — in-memory fake
    fake-artifact-store.ts        — in-memory fake
    index.ts                      — barrel re-exports
  __tests__/
    test-doubles-smoke.test.ts    — smoke test instantiating all fakes
```

## Verification

```bash
pnpm --filter @ai-sdlc/application typecheck
pnpm --filter @ai-sdlc/application test --run test-doubles-smoke
pnpm -r typecheck && pnpm depcruise
```
