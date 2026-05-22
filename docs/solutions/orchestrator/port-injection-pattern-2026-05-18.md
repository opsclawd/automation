---
title: Application/infrastructure layer boundary — port injection pattern
date: 2026-05-18
category: orchestrator
module: packages/application
problem_type: layer-boundary
component: ports
symptoms:
  - application layer importing infrastructure causes depcruise failures
  - Cross-layer coupling makes testing difficult
root_cause: missing_port_abstractions
resolution_type: pattern
severity: high
related_components:
  - packages/application/src/ports.ts
  - packages/application/src/start-issue-run.ts
  - apps/api/src/compose.ts
tags:
  - layer-boundary
  - port-injection
  - dependency-inversion
  - testing
---

# Application/Infrastructure Layer Boundary — Port Injection Pattern

## Rule

`packages/application` MUST NOT import `@ai-sdlc/infrastructure`. Enforced by `pnpm depcruise` in CI.

When application code needs infrastructure behavior (filesystem I/O, database, child processes), define a **port** (interface or function type) in `packages/application/src/ports.ts` and add it to the use case's `Deps`. The infra adapter is injected from `apps/api/src/compose.ts` — the only legal cross-layer wiring point.

## Port Pattern

### 1. Define the port in `ports.ts`

```typescript
// packages/application/src/ports.ts

// Function-type port (stateless)
export type ClassifyExitFn = (input: ClassifyExitInput) => Failure;

// Interface port (stateful)
export interface FailureRepositoryPort {
  insert(failure: Failure): void;
  findLatestByRun(runUuid: string): Failure | undefined;
}

// RunDirectoryHandle — filesystem operations for a run directory
export interface RunDirectoryHandle {
  readonly paths: {
    readonly stdoutLogPath: string;
    readonly stderrLogPath: string;
    readonly combinedLogPath: string;
    readonly eventsJsonlPath: string;
  };
  writeFailureJson(failure: Failure): void;
  readCombinedLog(): string;
}
```

### 2. Add port to use case Deps

```typescript
// packages/application/src/start-issue-run.ts

export interface StartIssueRunDeps {
  // ... existing deps ...
  classifyExit: ClassifyExitFn;
  failureRepository: FailureRepositoryPort;
  dir: RunDirectoryHandle;
  logger: { error(msg: string, err?: unknown): void };
}
```

### 3. Wire in compose.ts

```typescript
// apps/api/src/compose.ts

const classifyExitAdapter: ClassifyExitFn = (input) => {
  return classifyExit(input); // from @ai-sdlc/infrastructure
};

// In StartIssueRun deps:
const startIssueRun = new StartIssueRun({
  // ... other deps
  classifyExit: classifyExitAdapter,
  failureRepository: failureRepository,
  dir: runDirectory,
  logger: console,
});
```

### 4. Use fakes in tests

```typescript
// packages/application/src/__tests__/start-issue-run.test.ts

const fakeDir: RunDirectoryHandle = {
  paths: { stdoutLogPath: '', stderrLogPath: '', combinedLogPath: '', eventsJsonlPath: '' },
  writeFailureJson: vi.fn(),
  readCombinedLog: () => '',
};

const startIssueRun = new StartIssueRun({
  // ...
  dir: fakeDir,
  // ...
});
```

## When to Use Function Type vs Interface

| Port type                                | When to use                 | Example                                       |
| ---------------------------------------- | --------------------------- | --------------------------------------------- |
| Function type (`type Fn = (...) => ...`) | Stateless, single-operation | `ClassifyExitFn`, `RunBashScriptFn`           |
| Interface                                | Stateful, multi-method      | `FailureRepositoryPort`, `RunDirectoryHandle` |

## Common Ports in This Codebase

| Port                    | File                       | Purpose                      |
| ----------------------- | -------------------------- | ---------------------------- |
| `ClassifyExitFn`        | `ports.ts`                 | Failure classification       |
| `FailureRepositoryPort` | `ports.ts`                 | Persist/query failures       |
| `RunDirectoryHandle`    | `ports.ts`                 | Run directory filesystem ops |
| `EventRepositoryPort`   | `ports.ts`                 | Event persistence            |
| `EventBusPort`          | `ports.ts`                 | SSE subscriber registry      |
| `EventTailerFactory`    | `ports.ts`                 | Event file tailer            |
| `RepositoryPort`        | `ports.ts`                 | Repo registry queries        |
| `JobQueuePort`          | `ports/job-queue-port.ts`  | Job enqueue/claim            |
| `GitHubPort`            | `ports/github-port.ts`     | GitHub API calls             |
| `GitPort`               | `ports/git-port.ts`        | Git operations               |
| `ValidationPort`        | `ports/validation-port.ts` | Run validation commands      |
| `ArtifactStore`         | `ports/artifact-store.ts`  | Artifact persistence         |

## Key Gotcha: Domain types flow inward, not outward

`packages/domain` may only import `@ai-sdlc/shared`. Domain types (`Run`, `Failure`, `Phase`, `Job`, `Repository`) are pure and have no framework imports. Infrastructure implementations import domain types as `type` only:

```typescript
// packages/infrastructure/src/run-directory.ts
import type { Run } from '@ai-sdlc/domain';
```

This preserves layer purity — domain types can be used in tests without mocking filesystem or database.

## Adding a New Port

1. **Define** in `packages/application/src/ports.ts` (or `ports/<name>-port.ts` for larger ports)
2. **Add** to the `Deps` interface of any use case that needs it
3. **Wire** in `apps/api/src/compose.ts`
4. **Fake** in `packages/application/src/test-doubles/fake-<name>-port.ts`
5. **Verify** with `pnpm depcruise`

## What NOT to Do

Never add `@ai-sdlc/infrastructure` to `packages/application/package.json` dependencies. If you find yourself wanting to, stop — define a port instead.
