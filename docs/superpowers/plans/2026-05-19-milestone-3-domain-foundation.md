# Milestone 3 — Domain / Application Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Autonomous-loop note:** Each numbered Story below is a self-contained PR-sized chunk. An autonomous loop should pick one Story, implement every Task inside it, run the verification commands, and commit. **The orchestrator handles branch creation, push, and PR opening — stories must not push or call `gh pr create` themselves.** Do **not** mix stories in a single PR — the milestone-stories document explicitly sizes each as one PR.

**Goal:** Establish Clean-Architecture seams (Repository registry, Job queue, Worker, WorkerLease) and the runtime-agnostic `AgentPort` abstraction in `packages/domain` and `packages/application`, with in-memory fakes for every port, so that M4–M8 can plug in real adapters without touching domain or application code.

**Architecture:** Pure types and use-case interfaces live in `packages/domain` and `packages/application`. Side effects are expressed only as ports (interfaces in `packages/application/src/ports.ts`). Every port has an in-memory fake in a new `packages/application/src/test-doubles/` folder. The composition root (`apps/api/src/compose.ts`) is the only place infra adapters are wired. No file in `packages/domain/**` or `packages/application/**` may import `@ai-sdlc/infrastructure`, `opencode`, `pi`, `child_process`, `node:fs`, or `better-sqlite3` — this is enforced by `pnpm depcruise`.

**Tech Stack:** TypeScript 5.x strict, Vitest, Zod (schema in `@ai-sdlc/shared`), `fast-check` (property tests — install in Story 1). No new runtime deps in domain/application.

---

## Cross-cutting conventions (read once before starting any story)

- **Layer rule (hard):** `packages/domain` may only import `@ai-sdlc/shared`. `packages/application` may import `@ai-sdlc/domain` and `@ai-sdlc/shared`. Neither may import `@ai-sdlc/infrastructure`. Violations fail `pnpm depcruise`. See `AGENTS.md` "Layer boundaries".
- **Branded types:** Use the pattern `type RunId = string & { readonly __brand: 'RunId' }` plus a constructor `function RunId(s: string): RunId { return s as RunId }`. Branded IDs already exist for `displayId` in `@ai-sdlc/shared/ids/run-id.ts`; follow that style.
- **Domain-only constraint:** Pure functions, no `Date.now()`, no `crypto.randomUUID()` inside domain modules — the caller (application layer) passes `now: Date` and `id: string` in. Look at `packages/domain/src/run.ts:createRun` for the precedent.
- **Test-doubles location:** All in-memory fakes go in `packages/application/src/test-doubles/<port-name>.ts` and are exported from a new `packages/application/src/test-doubles/index.ts`. Existing tests (`start-issue-run.test.ts`) inline their fakes — do NOT refactor those; introduce the new folder cleanly.
- **Verification before commit (every task that touches code):**
  ```
  pnpm -r typecheck
  pnpm -r test --run
  pnpm lint
  pnpm depcruise
  ```
  All four must pass before the commit step.
- **Commit style:** Conventional commits. Scope = story id, e.g. `feat(m3-01): add core domain types`. Each step that says "Commit" is one commit.
- **Commit cadence (hard rule):** Commit after **every** task once its verification passes — not just at the end of the story. This gives the autonomous loop per-task recovery checkpoints (`git reset --hard HEAD` rewinds exactly one task) and makes the eventual squashed PR diff readable commit-by-commit. The final task of each story is a **final verification only** — by that point every prior task has already landed its own commit.
- **Stage only the task's files:** Each commit step lists the exact paths to `git add`. Do not use `git add -A` or `git add .` — staging unrelated changes defeats the per-task recovery property.
- **Branch / push / PR are orchestrator-managed:** Do not create branches, push, or open PRs from inside a story. Land your work as commits on the current branch and stop. The orchestrator will package the changes into a PR.

---

## Story M3-01 — Core domain types and invariants

**PR scope:** Add pure-domain branded ID types and the additional state-transition functions M3 needs on top of the M1 `Run` type. Adds `fast-check` for property tests. No application or infra changes.

**Files:**

- Create: `packages/domain/src/ids.ts`
- Modify: `packages/domain/src/run.ts` (add `transitionToReady`, `reactivate` state transitions; existing `createRun`/`startPhase`/`completePhase`/`failRun`/`passRun`/`cancelRun` stay untouched)
- Modify: `packages/domain/src/index.ts` (export new module)
- Create: `packages/domain/src/__tests__/ids.test.ts`
- Create: `packages/domain/src/__tests__/run-transitions.test.ts`
- Modify: `packages/domain/package.json` (add `fast-check` devDependency)

### Task 1: Add `fast-check` devDependency to domain

- [ ] **Step 1: Install fast-check**

Run from repo root:

```
pnpm --filter @ai-sdlc/domain add -D fast-check
```

Expected: `fast-check` listed under `devDependencies` in `packages/domain/package.json`.

- [ ] **Step 2: Verify install**

Run: `pnpm --filter @ai-sdlc/domain test --run`
Expected: existing domain tests still pass.

- [ ] **Step 3: Commit**

```
git add packages/domain/package.json pnpm-lock.yaml
git commit -m "chore(m3-01): add fast-check to @ai-sdlc/domain devDependencies"
```

### Task 2: Branded ID types

- [ ] **Step 1: Write failing test** — create `packages/domain/src/__tests__/ids.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { RunId, IssueNumber, PhaseName, RepositoryId, JobId, WorkerId } from '../ids.js';

describe('branded ids', () => {
  it('constructs and round-trips RunId', () => {
    const id = RunId('abc');
    expect(id).toBe('abc');
  });
  it('IssueNumber rejects non-positive integers', () => {
    expect(() => IssueNumber(0)).toThrow();
    expect(() => IssueNumber(-1)).toThrow();
    expect(() => IssueNumber(1.5)).toThrow();
    expect(IssueNumber(123)).toBe(123);
  });
  it('PhaseName rejects empty strings', () => {
    expect(() => PhaseName('')).toThrow();
    expect(PhaseName('plan-design')).toBe('plan-design');
  });
  it('RepositoryId, JobId, WorkerId accept non-empty strings', () => {
    expect(RepositoryId('r1')).toBe('r1');
    expect(JobId('j1')).toBe('j1');
    expect(WorkerId('w1')).toBe('w1');
    expect(() => RepositoryId('')).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ai-sdlc/domain test --run ids`
Expected: FAIL, "Cannot find module '../ids.js'".

- [ ] **Step 3: Implement ids.ts** — create `packages/domain/src/ids.ts`:

```ts
export type RunId = string & { readonly __brand: 'RunId' };
export type IssueNumber = number & { readonly __brand: 'IssueNumber' };
export type PhaseName = string & { readonly __brand: 'PhaseName' };
export type RepositoryId = string & { readonly __brand: 'RepositoryId' };
export type JobId = string & { readonly __brand: 'JobId' };
export type WorkerId = string & { readonly __brand: 'WorkerId' };

function nonEmpty(name: string, v: string): void {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

export function RunId(v: string): RunId {
  nonEmpty('RunId', v);
  return v as RunId;
}
export function PhaseName(v: string): PhaseName {
  nonEmpty('PhaseName', v);
  return v as PhaseName;
}
export function RepositoryId(v: string): RepositoryId {
  nonEmpty('RepositoryId', v);
  return v as RepositoryId;
}
export function JobId(v: string): JobId {
  nonEmpty('JobId', v);
  return v as JobId;
}
export function WorkerId(v: string): WorkerId {
  nonEmpty('WorkerId', v);
  return v as WorkerId;
}

export function IssueNumber(v: number): IssueNumber {
  if (!Number.isInteger(v) || v <= 0) {
    throw new Error(`IssueNumber must be a positive integer, got ${v}`);
  }
  return v as IssueNumber;
}
```

- [ ] **Step 4: Wire export** — append to `packages/domain/src/index.ts`:

```ts
export * from './ids.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @ai-sdlc/domain test --run ids`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```
git add packages/domain/src/ids.ts packages/domain/src/__tests__/ids.test.ts packages/domain/src/index.ts
git commit -m "feat(m3-01): add branded ID types (RunId, IssueNumber, PhaseName, RepositoryId, JobId, WorkerId)"
```

### Task 3: Add `transitionToReady` and `reactivate` state transitions

Context: PRD Q9/Q10/Q33 — READY is a resting state for post-PR-merge waiting; new review activity reactivates a READY run back to RUNNING. `RunStatus` already includes `waiting` — treat `waiting` as the READY state.

- [ ] **Step 1: Write failing tests** — create `packages/domain/src/__tests__/run-transitions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createRun, transitionToReady, reactivate, RunStateError } from '../run.js';

const baseInput = { uuid: 'u', displayId: 'd', issueNumber: 1, startedAt: new Date('2026-01-01') };

describe('transitionToReady', () => {
  it('transitions a running run with no currentPhase to waiting', () => {
    const run = createRun(baseInput);
    const ready = transitionToReady(run);
    expect(ready.status).toBe('waiting');
  });
  it('rejects if a phase is still currentPhase', () => {
    let run = createRun(baseInput);
    run = { ...run, currentPhase: 'review' };
    expect(() => transitionToReady(run)).toThrow(RunStateError);
  });
  it('rejects if run is already terminal', () => {
    const run = { ...createRun(baseInput), status: 'passed' as const, completedAt: new Date() };
    expect(() => transitionToReady(run)).toThrow(RunStateError);
  });
});

describe('reactivate', () => {
  it('moves a waiting run back to running', () => {
    let run = createRun(baseInput);
    run = transitionToReady(run);
    const back = reactivate(run);
    expect(back.status).toBe('running');
  });
  it('rejects reactivating a non-waiting run', () => {
    const run = createRun(baseInput);
    expect(() => reactivate(run)).toThrow(RunStateError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ai-sdlc/domain test --run run-transitions`
Expected: FAIL, "transitionToReady is not a function".

- [ ] **Step 3: Implement transitions** — append to `packages/domain/src/run.ts` (after the existing exports, before the file end):

```ts
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

export function reactivate(run: Run): Run {
  if (run.status !== 'waiting') {
    throw new RunStateError(
      `cannot reactivate ${run.displayId}: status is '${run.status}', expected 'waiting'`,
    );
  }
  return { ...run, status: 'running' };
}
```

- [ ] **Step 4: Run all domain tests to verify**

Run: `pnpm --filter @ai-sdlc/domain test --run`
Expected: PASS (all tests, including the new ones).

- [ ] **Step 5: Commit**

```
git add packages/domain/src/run.ts packages/domain/src/__tests__/run-transitions.test.ts
git commit -m "feat(m3-01): add transitionToReady and reactivate state transitions on Run"
```

### Task 4: Property test — no path from `running` to `passed` without going through all required phases

(This is the invariant called out in M3-01 acceptance.)

- [ ] **Step 1: Append to `run-transitions.test.ts`:**

```ts
import fc from 'fast-check';
import { startPhase, completePhase, passRun } from '../run.js';

describe('property: passRun requires no pending currentPhase', () => {
  it('passRun throws when called mid-phase', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (phaseName) => {
        let run = createRun(baseInput);
        run = startPhase(run, phaseName);
        expect(() => passRun(run, new Date())).toThrow();
      }),
    );
  });
});
```

- [ ] **Step 2: Verify `passRun` exists** — open `packages/domain/src/run.ts` and confirm `passRun` is exported. If the existing `passRun` signature differs (e.g. arity is different), adapt the test to match the real signature rather than changing the function.

- [ ] **Step 3: Run test**

Run: `pnpm --filter @ai-sdlc/domain test --run run-transitions`
Expected: PASS.

- [ ] **Step 4: Commit**

```
git add packages/domain/src/__tests__/run-transitions.test.ts
git commit -m "test(m3-01): property test — passRun rejects mid-phase runs"
```

### Task 5: Final verification

- [ ] **Step 1: Full verification**

Run from repo root:

```
pnpm -r typecheck && pnpm -r test --run && pnpm lint && pnpm depcruise
```

Expected: all green. (All work is already committed via per-task commits above; no further commit here.)

---

## Story M3-02 — Repository registry domain and `RepositoryPort`

**PR scope:** Add the `Repository` domain type, `RepositoryPort` interface, `RepositoryNotApprovedError`, and an in-memory fake. Application use cases that accept a `RepositoryId` (added later) will gate on enabled repositories.

**Files:**

- Create: `packages/domain/src/repository.ts`
- Modify: `packages/domain/src/index.ts` (export it)
- Create: `packages/application/src/ports/repository-port.ts`
- Modify: `packages/application/src/ports.ts` (re-export the new port file to keep existing barrel)
- Create: `packages/application/src/test-doubles/fake-repository-port.ts`
- Create: `packages/application/src/test-doubles/index.ts` (if not present)
- Create: `packages/application/src/__tests__/fake-repository-port.test.ts`

### Task 1: Define the `Repository` domain type

- [ ] **Step 1: Write failing test** — create `packages/domain/src/__tests__/repository.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Repository, RepositoryNotApprovedError } from '../repository.js';
import { RepositoryId } from '../ids.js';

describe('Repository', () => {
  it('exposes RepositoryNotApprovedError class', () => {
    const e = new RepositoryNotApprovedError(RepositoryId('r'));
    expect(e.name).toBe('RepositoryNotApprovedError');
    expect(e).toBeInstanceOf(Error);
  });
  it('Repository type carries expected fields (compile-time)', () => {
    const r: Repository = {
      id: RepositoryId('r'),
      owner: 'o',
      name: 'n',
      fullName: 'o/n',
      defaultBranch: 'main',
      localBasePath: '/tmp/r',
      enabled: true,
      maxConcurrentRuns: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(r.maxConcurrentRuns).toBe(1);
  });
});
```

- [ ] **Step 2: Run test — expect fail**

Run: `pnpm --filter @ai-sdlc/domain test --run repository`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** — create `packages/domain/src/repository.ts`:

```ts
import type { RepositoryId } from './ids.js';

export interface Repository {
  id: RepositoryId;
  owner: string;
  name: string;
  fullName: string; // "owner/name"
  defaultBranch: string;
  localBasePath: string; // e.g. /var/lib/ai-orchestrator/repos/owner__name
  enabled: boolean;
  maxConcurrentRuns: 1; // hardcoded to 1 per ADR-0008
  createdAt: Date;
  updatedAt: Date;
}

export class RepositoryNotApprovedError extends Error {
  readonly repositoryId: RepositoryId;
  constructor(repositoryId: RepositoryId) {
    super(`Repository ${repositoryId} is not approved/registered or is disabled`);
    this.name = 'RepositoryNotApprovedError';
    this.repositoryId = repositoryId;
  }
}
```

- [ ] **Step 4: Export** — append to `packages/domain/src/index.ts`:

```ts
export * from './repository.js';
```

- [ ] **Step 5: Run test**

Run: `pnpm --filter @ai-sdlc/domain test --run repository`
Expected: PASS.

- [ ] **Step 6: Commit**

```
git add packages/domain/src/repository.ts packages/domain/src/__tests__/repository.test.ts packages/domain/src/index.ts
git commit -m "feat(m3-02): add Repository domain type and RepositoryNotApprovedError"
```

### Task 2: Define `RepositoryPort`

- [ ] **Step 1: Create the port file** — `packages/application/src/ports/repository-port.ts`:

```ts
import type { Repository, RepositoryId } from '@ai-sdlc/domain';

export interface RepositoryPort {
  findById(id: RepositoryId): Repository | undefined;
  findByFullName(fullName: string): Repository | undefined;
  listEnabled(): Repository[];
}
```

- [ ] **Step 2: Re-export from the existing ports barrel** — append to `packages/application/src/ports.ts`:

```ts
export type { RepositoryPort } from './ports/repository-port.js';
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @ai-sdlc/application typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```
git add packages/application/src/ports/repository-port.ts packages/application/src/ports.ts
git commit -m "feat(m3-02): add RepositoryPort interface"
```

### Task 3: In-memory fake `RepositoryPort` + tests

- [ ] **Step 1: Write failing test** — create `packages/application/src/__tests__/fake-repository-port.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { RepositoryId } from '@ai-sdlc/domain';
import { FakeRepositoryPort } from '../test-doubles/index.js';

describe('FakeRepositoryPort', () => {
  it('returns undefined for an unknown id', () => {
    const p = new FakeRepositoryPort([]);
    expect(p.findById(RepositoryId('missing'))).toBeUndefined();
  });
  it('returns the repository for a known id', () => {
    const p = new FakeRepositoryPort([
      {
        id: RepositoryId('r1'),
        owner: 'o',
        name: 'n',
        fullName: 'o/n',
        defaultBranch: 'main',
        localBasePath: '/tmp/r1',
        enabled: true,
        maxConcurrentRuns: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    expect(p.findById(RepositoryId('r1'))?.fullName).toBe('o/n');
  });
  it('listEnabled excludes disabled repos', () => {
    const base = {
      owner: 'o',
      name: 'n',
      defaultBranch: 'main',
      localBasePath: '/x',
      maxConcurrentRuns: 1 as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const p = new FakeRepositoryPort([
      { ...base, id: RepositoryId('a'), fullName: 'o/a', enabled: true },
      { ...base, id: RepositoryId('b'), fullName: 'o/b', enabled: false },
    ]);
    expect(p.listEnabled().map((r) => r.id)).toEqual(['a']);
  });
  it('findByFullName works', () => {
    const p = new FakeRepositoryPort([
      {
        id: RepositoryId('r1'),
        owner: 'o',
        name: 'n',
        fullName: 'o/n',
        defaultBranch: 'main',
        localBasePath: '/x',
        enabled: true,
        maxConcurrentRuns: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    expect(p.findByFullName('o/n')?.id).toBe('r1');
  });
});
```

- [ ] **Step 2: Run test — expect fail**

Run: `pnpm --filter @ai-sdlc/application test --run fake-repository-port`
Expected: FAIL, module `../test-doubles/index.js` not found.

- [ ] **Step 3: Implement fake** — create `packages/application/src/test-doubles/fake-repository-port.ts`:

```ts
import type { Repository, RepositoryId } from '@ai-sdlc/domain';
import type { RepositoryPort } from '../ports/repository-port.js';

export class FakeRepositoryPort implements RepositoryPort {
  private byId = new Map<RepositoryId, Repository>();
  constructor(seed: Repository[] = []) {
    for (const r of seed) this.byId.set(r.id, r);
  }
  findById(id: RepositoryId): Repository | undefined {
    return this.byId.get(id);
  }
  findByFullName(fullName: string): Repository | undefined {
    for (const r of this.byId.values()) if (r.fullName === fullName) return r;
    return undefined;
  }
  listEnabled(): Repository[] {
    return [...this.byId.values()].filter((r) => r.enabled);
  }
  add(r: Repository): void {
    this.byId.set(r.id, r);
  }
}
```

- [ ] **Step 4: Create barrel** — `packages/application/src/test-doubles/index.ts`:

```ts
export * from './fake-repository-port.js';
```

- [ ] **Step 5: Run test**

Run: `pnpm --filter @ai-sdlc/application test --run fake-repository-port`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```
git add packages/application/src/test-doubles/fake-repository-port.ts packages/application/src/test-doubles/index.ts packages/application/src/__tests__/fake-repository-port.test.ts
git commit -m "test(m3-02): add FakeRepositoryPort in-memory test double"
```

### Task 4: Final verification

- [ ] **Step 1:** `pnpm -r typecheck && pnpm -r test --run && pnpm lint && pnpm depcruise`
- [ ] **Step 2: Stop.** All work is already committed via per-task commits. The orchestrator handles push + PR.

---

## Story M3-03 — Job queue domain and `JobQueuePort`

**PR scope:** Add the `Job` domain type, lifecycle helpers, `JobQueuePort`, and an in-memory fake with FIFO + priority semantics that refuses double-claim and rejects jobs for unknown/disabled repos.

**Files:**

- Create: `packages/domain/src/job.ts`
- Modify: `packages/domain/src/index.ts`
- Create: `packages/application/src/ports/job-queue-port.ts`
- Modify: `packages/application/src/ports.ts`
- Create: `packages/application/src/test-doubles/fake-job-queue-port.ts`
- Modify: `packages/application/src/test-doubles/index.ts`
- Create: `packages/application/src/__tests__/fake-job-queue-port.test.ts`
- Create: `packages/domain/src/__tests__/job.test.ts`

### Task 1: `Job` domain type and pure transitions

- [ ] **Step 1: Failing test** — `packages/domain/src/__tests__/job.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { JobId, RepositoryId, RunId, WorkerId, IssueNumber } from '../ids.js';
import {
  createJob,
  claimJob,
  markJobRunning,
  markJobSucceeded,
  markJobFailed,
  markJobCancelled,
  JobStateError,
} from '../job.js';

const base = {
  id: JobId('j1'),
  runId: RunId('r1'),
  repoId: RepositoryId('repo1'),
  issueNumber: IssueNumber(7),
  priority: 0,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

describe('Job lifecycle', () => {
  it('createJob starts in queued', () => {
    const j = createJob(base);
    expect(j.status).toBe('queued');
    expect(j.attempts).toBe(0);
  });
  it('claimJob moves queued → claimed and assigns worker', () => {
    const j = claimJob(createJob(base), WorkerId('w1'), new Date());
    expect(j.status).toBe('claimed');
    expect(j.claimedBy).toBe('w1');
    expect(j.attempts).toBe(1);
  });
  it('claimJob refuses to claim a non-queued job', () => {
    const claimed = claimJob(createJob(base), WorkerId('w1'), new Date());
    expect(() => claimJob(claimed, WorkerId('w2'), new Date())).toThrow(JobStateError);
  });
  it('markJobRunning requires claimed', () => {
    expect(() => markJobRunning(createJob(base), new Date())).toThrow(JobStateError);
    const claimed = claimJob(createJob(base), WorkerId('w1'), new Date());
    expect(markJobRunning(claimed, new Date()).status).toBe('running');
  });
  it('markJobSucceeded sets status + completedAt', () => {
    let j = claimJob(createJob(base), WorkerId('w1'), new Date());
    j = markJobRunning(j, new Date());
    const done = markJobSucceeded(j, new Date('2026-01-02'));
    expect(done.status).toBe('succeeded');
    expect(done.completedAt).toEqual(new Date('2026-01-02'));
  });
  it('markJobFailed and markJobCancelled work from running', () => {
    let j = claimJob(createJob(base), WorkerId('w1'), new Date());
    j = markJobRunning(j, new Date());
    expect(markJobFailed(j, new Date()).status).toBe('failed');
    expect(markJobCancelled(j, new Date()).status).toBe('cancelled');
  });
  it('cannot cancel a terminal job', () => {
    let j = claimJob(createJob(base), WorkerId('w1'), new Date());
    j = markJobRunning(j, new Date());
    const failed = markJobFailed(j, new Date());
    expect(() => markJobCancelled(failed, new Date())).toThrow(JobStateError);
  });
});
```

- [ ] **Step 2: Run — expect fail.**

- [ ] **Step 3: Implement** — `packages/domain/src/job.ts`:

```ts
import type { JobId, RepositoryId, RunId, WorkerId, IssueNumber } from './ids.js';

export type JobStatus = 'queued' | 'claimed' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Job {
  id: JobId;
  runId: RunId;
  repoId: RepositoryId;
  issueNumber: IssueNumber;
  status: JobStatus;
  priority: number; // higher = drains first
  attempts: number;
  claimedBy?: WorkerId;
  createdAt: Date;
  claimedAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
}

export interface CreateJobInput {
  id: JobId;
  runId: RunId;
  repoId: RepositoryId;
  issueNumber: IssueNumber;
  priority?: number;
  createdAt: Date;
}

export class JobStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobStateError';
  }
}

const TERMINAL: ReadonlySet<JobStatus> = new Set(['succeeded', 'failed', 'cancelled']);

export function createJob(input: CreateJobInput): Job {
  return {
    id: input.id,
    runId: input.runId,
    repoId: input.repoId,
    issueNumber: input.issueNumber,
    status: 'queued',
    priority: input.priority ?? 0,
    attempts: 0,
    createdAt: input.createdAt,
  };
}

export function claimJob(job: Job, workerId: WorkerId, now: Date): Job {
  if (job.status !== 'queued') {
    throw new JobStateError(
      `cannot claim job ${job.id}: status is '${job.status}', expected 'queued'`,
    );
  }
  return {
    ...job,
    status: 'claimed',
    claimedBy: workerId,
    claimedAt: now,
    attempts: job.attempts + 1,
  };
}

export function markJobRunning(job: Job, now: Date): Job {
  if (job.status !== 'claimed') {
    throw new JobStateError(
      `cannot mark job ${job.id} running: status is '${job.status}', expected 'claimed'`,
    );
  }
  return { ...job, status: 'running', startedAt: now };
}

function terminate(job: Job, status: 'succeeded' | 'failed' | 'cancelled', now: Date): Job {
  if (TERMINAL.has(job.status)) {
    throw new JobStateError(`cannot transition job ${job.id} to ${status}: already ${job.status}`);
  }
  return { ...job, status, completedAt: now };
}

export function markJobSucceeded(job: Job, now: Date): Job {
  return terminate(job, 'succeeded', now);
}
export function markJobFailed(job: Job, now: Date): Job {
  return terminate(job, 'failed', now);
}
export function markJobCancelled(job: Job, now: Date): Job {
  return terminate(job, 'cancelled', now);
}
```

- [ ] **Step 4: Export** in `packages/domain/src/index.ts`:

```ts
export * from './job.js';
```

- [ ] **Step 5: Run domain tests — expect PASS.**

- [ ] **Step 6: Commit**

```
git add packages/domain/src/job.ts packages/domain/src/__tests__/job.test.ts packages/domain/src/index.ts
git commit -m "feat(m3-03): add Job domain type and lifecycle transitions"
```

### Task 2: `JobQueuePort` interface

- [ ] **Step 1: Create** `packages/application/src/ports/job-queue-port.ts`:

```ts
import type { Job, JobId, RepositoryId, RunId, WorkerId } from '@ai-sdlc/domain';

export interface EnqueueJobInput {
  job: Job;
}

export interface JobQueuePort {
  enqueue(input: EnqueueJobInput): void;
  claimNext(input: { workerId: WorkerId }): Job | undefined;
  markRunning(jobId: JobId, now: Date): void;
  markSucceeded(jobId: JobId, now: Date): void;
  markFailed(jobId: JobId, now: Date): void;
  markCancelled(jobId: JobId, now: Date): void;
  listForRepo(repoId: RepositoryId): Job[];
  listForRun(runId: RunId): Job[];
  findById(jobId: JobId): Job | undefined;
}
```

- [ ] **Step 2: Re-export from `ports.ts`:**

```ts
export type { JobQueuePort, EnqueueJobInput } from './ports/job-queue-port.js';
```

- [ ] **Step 3: Commit**

```
git add packages/application/src/ports/job-queue-port.ts packages/application/src/ports.ts
git commit -m "feat(m3-03): add JobQueuePort interface"
```

### Task 3: In-memory fake `JobQueuePort`

Behaviour the fake must enforce:

- `enqueue` rejects when `job.repoId` is not present in the injected `RepositoryPort.findById(...)`, OR when the repository is `enabled: false`. (Pass a `RepositoryPort` into the fake's constructor; this is the cheap way to express the cross-port invariant.)
- `claimNext` returns the highest-`priority`, oldest-`createdAt`, `status === 'queued'` job and atomically marks it `claimed`.
- Double-claim of the same `Job` returns `undefined` on the second call (because the job is no longer queued).
- `listForRepo` returns all jobs for that repo (any status).

- [ ] **Step 1: Failing test** — `packages/application/src/__tests__/fake-job-queue-port.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createJob, JobId, RepositoryId, RunId, WorkerId, IssueNumber } from '@ai-sdlc/domain';
import { FakeRepositoryPort, FakeJobQueuePort } from '../test-doubles/index.js';

function repo(id: string, enabled = true) {
  return {
    id: RepositoryId(id),
    owner: 'o',
    name: id,
    fullName: `o/${id}`,
    defaultBranch: 'main',
    localBasePath: `/x/${id}`,
    enabled,
    maxConcurrentRuns: 1 as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function job(id: string, repoId: string, opts: { priority?: number; createdAt?: Date } = {}) {
  return createJob({
    id: JobId(id),
    runId: RunId(`run-${id}`),
    repoId: RepositoryId(repoId),
    issueNumber: IssueNumber(1),
    priority: opts.priority,
    createdAt: opts.createdAt ?? new Date(),
  });
}

describe('FakeJobQueuePort', () => {
  it('enqueue rejects an unknown repo', () => {
    const q = new FakeJobQueuePort(new FakeRepositoryPort([]));
    expect(() => q.enqueue({ job: job('j1', 'unknown') })).toThrow(/not approved/);
  });
  it('enqueue rejects a disabled repo', () => {
    const q = new FakeJobQueuePort(new FakeRepositoryPort([repo('r1', false)]));
    expect(() => q.enqueue({ job: job('j1', 'r1') })).toThrow(/not approved/);
  });
  it('claimNext returns the highest-priority oldest queued job', () => {
    const q = new FakeJobQueuePort(new FakeRepositoryPort([repo('r1')]));
    q.enqueue({ job: job('a', 'r1', { priority: 0, createdAt: new Date('2026-01-01') }) });
    q.enqueue({ job: job('b', 'r1', { priority: 5, createdAt: new Date('2026-01-02') }) });
    q.enqueue({ job: job('c', 'r1', { priority: 5, createdAt: new Date('2026-01-01') }) });
    const claimed = q.claimNext({ workerId: WorkerId('w1') });
    expect(claimed?.id).toBe('c');
  });
  it('claimNext on second attempt for the same queue returns the next job', () => {
    const q = new FakeJobQueuePort(new FakeRepositoryPort([repo('r1')]));
    q.enqueue({ job: job('a', 'r1') });
    q.enqueue({ job: job('b', 'r1', { createdAt: new Date(Date.now() + 1000) }) });
    expect(q.claimNext({ workerId: WorkerId('w1') })?.id).toBe('a');
    expect(q.claimNext({ workerId: WorkerId('w2') })?.id).toBe('b');
  });
  it('claimNext returns undefined when nothing is queued', () => {
    const q = new FakeJobQueuePort(new FakeRepositoryPort([repo('r1')]));
    expect(q.claimNext({ workerId: WorkerId('w1') })).toBeUndefined();
  });
  it('lifecycle: claim → markRunning → markSucceeded', () => {
    const q = new FakeJobQueuePort(new FakeRepositoryPort([repo('r1')]));
    q.enqueue({ job: job('a', 'r1') });
    const c = q.claimNext({ workerId: WorkerId('w1') })!;
    q.markRunning(c.id, new Date());
    q.markSucceeded(c.id, new Date());
    expect(q.findById(c.id)?.status).toBe('succeeded');
  });
  it('listForRepo / listForRun return matching jobs', () => {
    const q = new FakeJobQueuePort(new FakeRepositoryPort([repo('r1'), repo('r2')]));
    q.enqueue({ job: job('a', 'r1') });
    q.enqueue({ job: job('b', 'r2') });
    expect(q.listForRepo(RepositoryId('r1')).map((j) => j.id)).toEqual(['a']);
    expect(q.listForRun(RunId('run-a')).map((j) => j.id)).toEqual(['a']);
  });
});
```

- [ ] **Step 2: Run — expect fail.**

- [ ] **Step 3: Implement** — `packages/application/src/test-doubles/fake-job-queue-port.ts`:

```ts
import {
  type Job,
  type JobId,
  type RepositoryId,
  type RunId,
  type WorkerId,
  claimJob,
  markJobRunning,
  markJobSucceeded,
  markJobFailed,
  markJobCancelled,
  RepositoryNotApprovedError,
} from '@ai-sdlc/domain';
import type { JobQueuePort, EnqueueJobInput } from '../ports/job-queue-port.js';
import type { RepositoryPort } from '../ports/repository-port.js';

export class FakeJobQueuePort implements JobQueuePort {
  private jobs = new Map<JobId, Job>();
  constructor(private readonly repos: RepositoryPort) {}

  enqueue(input: EnqueueJobInput): void {
    const repo = this.repos.findById(input.job.repoId);
    if (!repo || !repo.enabled) {
      throw new RepositoryNotApprovedError(input.job.repoId);
    }
    if (this.jobs.has(input.job.id)) {
      throw new Error(`duplicate job id ${input.job.id}`);
    }
    this.jobs.set(input.job.id, input.job);
  }

  claimNext(input: { workerId: WorkerId }): Job | undefined {
    const queued = [...this.jobs.values()]
      .filter((j) => j.status === 'queued')
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      );
    const next = queued[0];
    if (!next) return undefined;
    const claimed = claimJob(next, input.workerId, new Date());
    this.jobs.set(claimed.id, claimed);
    return claimed;
  }

  markRunning(jobId: JobId, now: Date): void {
    this.update(jobId, (j) => markJobRunning(j, now));
  }
  markSucceeded(jobId: JobId, now: Date): void {
    this.update(jobId, (j) => markJobSucceeded(j, now));
  }
  markFailed(jobId: JobId, now: Date): void {
    this.update(jobId, (j) => markJobFailed(j, now));
  }
  markCancelled(jobId: JobId, now: Date): void {
    this.update(jobId, (j) => markJobCancelled(j, now));
  }

  listForRepo(repoId: RepositoryId): Job[] {
    return [...this.jobs.values()].filter((j) => j.repoId === repoId);
  }
  listForRun(runId: RunId): Job[] {
    return [...this.jobs.values()].filter((j) => j.runId === runId);
  }
  findById(jobId: JobId): Job | undefined {
    return this.jobs.get(jobId);
  }

  private update(jobId: JobId, fn: (j: Job) => Job): void {
    const existing = this.jobs.get(jobId);
    if (!existing) throw new Error(`unknown job ${jobId}`);
    this.jobs.set(jobId, fn(existing));
  }
}
```

- [ ] **Step 4: Export from barrel** — append to `packages/application/src/test-doubles/index.ts`:

```ts
export * from './fake-job-queue-port.js';
```

- [ ] **Step 5: Run tests — expect PASS.**

- [ ] **Step 6: Commit**

```
git add packages/application/src/test-doubles/fake-job-queue-port.ts packages/application/src/test-doubles/index.ts packages/application/src/__tests__/fake-job-queue-port.test.ts
git commit -m "test(m3-03): add FakeJobQueuePort in-memory test double"
```

### Task 4: Final verification

- [ ] **Step 1:** `pnpm -r typecheck && pnpm -r test --run && pnpm lint && pnpm depcruise`.
- [ ] **Step 2: Stop.** All work is already committed via per-task commits. The orchestrator handles push + PR.

---

## Story M3-04 — Worker / WorkerLease domain and ports

**PR scope:** Add `Worker`, `WorkerLease`, the two ports (`WorkerRegistryPort`, `WorkerLeasePort`), in-memory fakes that enforce one active lease per repo, and the stale-lease reclaim safety checks listed in ADR-0008.

**Files:**

- Create: `packages/domain/src/worker.ts`
- Create: `packages/domain/src/worker-lease.ts`
- Modify: `packages/domain/src/index.ts`
- Create: `packages/application/src/ports/worker-registry-port.ts`
- Create: `packages/application/src/ports/worker-lease-port.ts`
- Modify: `packages/application/src/ports.ts`
- Create: `packages/application/src/test-doubles/fake-worker-registry-port.ts`
- Create: `packages/application/src/test-doubles/fake-worker-lease-port.ts`
- Modify: `packages/application/src/test-doubles/index.ts`
- Create tests for each new file.

### Task 1: `Worker` and `WorkerLease` domain types

- [ ] **Step 1: Test** — `packages/domain/src/__tests__/worker.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { WorkerId, RepositoryId, RunId } from '../ids.js';
import {
  createWorker,
  heartbeatWorker,
  markWorkerStopping,
  markWorkerUnhealthy,
} from '../worker.js';

const w0 = {
  id: WorkerId('w1'),
  hostname: 'h',
  processId: 100,
  now: new Date('2026-01-01T00:00:00Z'),
};

describe('Worker', () => {
  it('createWorker starts idle', () => {
    expect(createWorker(w0).status).toBe('idle');
  });
  it('heartbeatWorker updates heartbeatAt', () => {
    const w = createWorker(w0);
    const ts = new Date('2026-01-01T00:01:00Z');
    expect(heartbeatWorker(w, ts).heartbeatAt).toEqual(ts);
  });
  it('markWorkerStopping / Unhealthy set status', () => {
    const w = createWorker(w0);
    expect(markWorkerStopping(w).status).toBe('stopping');
    expect(markWorkerUnhealthy(w).status).toBe('unhealthy');
  });
});
```

- [ ] **Step 2: Implement** — `packages/domain/src/worker.ts`:

```ts
import type { WorkerId } from './ids.js';

export type WorkerStatus = 'idle' | 'busy' | 'stopping' | 'unhealthy';

export interface Worker {
  id: WorkerId;
  hostname: string;
  processId: number;
  status: WorkerStatus;
  heartbeatAt: Date;
}

export interface CreateWorkerInput {
  id: WorkerId;
  hostname: string;
  processId: number;
  now: Date;
}

export function createWorker(input: CreateWorkerInput): Worker {
  return {
    id: input.id,
    hostname: input.hostname,
    processId: input.processId,
    status: 'idle',
    heartbeatAt: input.now,
  };
}
export function heartbeatWorker(w: Worker, now: Date): Worker {
  return { ...w, heartbeatAt: now };
}
export function markWorkerBusy(w: Worker): Worker {
  return { ...w, status: 'busy' };
}
export function markWorkerIdle(w: Worker): Worker {
  return { ...w, status: 'idle' };
}
export function markWorkerStopping(w: Worker): Worker {
  return { ...w, status: 'stopping' };
}
export function markWorkerUnhealthy(w: Worker): Worker {
  return { ...w, status: 'unhealthy' };
}
```

- [ ] **Step 3: WorkerLease type** — `packages/domain/src/worker-lease.ts`:

```ts
import type { RepositoryId, RunId, WorkerId } from './ids.js';

export interface WorkerLease {
  repoId: RepositoryId;
  workerId: WorkerId;
  runId: RunId;
  acquiredAt: Date;
  heartbeatAt: Date;
  expiresAt: Date;
}

export class WorkerLeaseConflictError extends Error {
  readonly repoId: RepositoryId;
  constructor(repoId: RepositoryId, currentWorker: WorkerId) {
    super(`Repository ${repoId} already has an active lease held by ${currentWorker}`);
    this.name = 'WorkerLeaseConflictError';
    this.repoId = repoId;
  }
}
```

- [ ] **Step 4: Export both** — append to `packages/domain/src/index.ts`:

```ts
export * from './worker.js';
export * from './worker-lease.js';
```

- [ ] **Step 5: Run all domain tests — expect PASS.**

- [ ] **Step 6: Commit**

```
git add packages/domain/src/worker.ts packages/domain/src/worker-lease.ts packages/domain/src/__tests__/worker.test.ts packages/domain/src/index.ts
git commit -m "feat(m3-04): add Worker and WorkerLease domain types"
```

### Task 2: `WorkerRegistryPort` interface + fake

- [ ] **Step 1: Port** — `packages/application/src/ports/worker-registry-port.ts`:

```ts
import type { Worker, WorkerId } from '@ai-sdlc/domain';

export interface WorkerRegistryPort {
  register(w: Worker): void;
  heartbeat(id: WorkerId, now: Date): void;
  markStopping(id: WorkerId): void;
  markUnhealthy(id: WorkerId): void;
  markBusy(id: WorkerId): void;
  markIdle(id: WorkerId): void;
  list(): Worker[];
  findById(id: WorkerId): Worker | undefined;
}
```

- [ ] **Step 2: Re-export from `ports.ts`:**

```ts
export type { WorkerRegistryPort } from './ports/worker-registry-port.js';
```

- [ ] **Step 3: Fake** — `packages/application/src/test-doubles/fake-worker-registry-port.ts`:

```ts
import {
  type Worker,
  type WorkerId,
  heartbeatWorker,
  markWorkerStopping,
  markWorkerUnhealthy,
  markWorkerBusy,
  markWorkerIdle,
} from '@ai-sdlc/domain';
import type { WorkerRegistryPort } from '../ports/worker-registry-port.js';

export class FakeWorkerRegistryPort implements WorkerRegistryPort {
  private workers = new Map<WorkerId, Worker>();
  register(w: Worker): void {
    this.workers.set(w.id, w);
  }
  heartbeat(id: WorkerId, now: Date): void {
    this.update(id, (w) => heartbeatWorker(w, now));
  }
  markStopping(id: WorkerId): void {
    this.update(id, markWorkerStopping);
  }
  markUnhealthy(id: WorkerId): void {
    this.update(id, markWorkerUnhealthy);
  }
  markBusy(id: WorkerId): void {
    this.update(id, markWorkerBusy);
  }
  markIdle(id: WorkerId): void {
    this.update(id, markWorkerIdle);
  }
  list(): Worker[] {
    return [...this.workers.values()];
  }
  findById(id: WorkerId): Worker | undefined {
    return this.workers.get(id);
  }
  private update(id: WorkerId, fn: (w: Worker) => Worker): void {
    const w = this.workers.get(id);
    if (!w) throw new Error(`unknown worker ${id}`);
    this.workers.set(id, fn(w));
  }
}
```

- [ ] **Step 4: Export + write a minimal test** confirming register + heartbeat + list. (Use the pattern from earlier fake tests; 4 small `it()`s is enough.)

- [ ] **Step 5: Commit**

```
git add packages/application/src/ports/worker-registry-port.ts packages/application/src/ports.ts packages/application/src/test-doubles/fake-worker-registry-port.ts packages/application/src/test-doubles/index.ts packages/application/src/__tests__/fake-worker-registry-port.test.ts
git commit -m "feat(m3-04): add WorkerRegistryPort + FakeWorkerRegistryPort"
```

### Task 3: `WorkerLeasePort` interface

- [ ] **Step 1:** Create `packages/application/src/ports/worker-lease-port.ts`:

```ts
import type { RepositoryId, RunId, WorkerId, WorkerLease } from '@ai-sdlc/domain';

export interface AcquireLeaseInput {
  repoId: RepositoryId;
  workerId: WorkerId;
  runId: RunId;
  now: Date;
  ttlMs: number;
}

export interface ReclaimExpiredInput {
  now: Date;
  /** Set of run ids whose Run is in failed/cancelled or explicitly marked recoverable. */
  recoverableRunIds: ReadonlySet<RunId>;
  /** Predicate: is the worker that holds the lease still alive? */
  isWorkerAlive(workerId: WorkerId): boolean;
  /** Callback: reset/quarantine the worktree before reclaim. Must succeed or reclaim aborts. */
  resetWorktree(repoId: RepositoryId): void;
  /** Callback: emit a lease.reclaimed event for audit. */
  onReclaimed(info: {
    repoId: RepositoryId;
    previousWorkerId: WorkerId;
    previousRunId: RunId;
    reason: string;
  }): void;
}

export interface WorkerLeasePort {
  acquire(input: AcquireLeaseInput): WorkerLease; // throws WorkerLeaseConflictError on conflict
  heartbeat(repoId: RepositoryId, workerId: WorkerId, now: Date, newExpiresAt: Date): void;
  release(repoId: RepositoryId, workerId: WorkerId): void; // idempotent
  current(repoId: RepositoryId): WorkerLease | undefined;
  reclaimExpired(input: ReclaimExpiredInput): WorkerLease[]; // returns reclaimed leases
}
```

- [ ] **Step 2:** Re-export from `ports.ts`.

- [ ] **Step 3: Commit**

```
git add packages/application/src/ports/worker-lease-port.ts packages/application/src/ports.ts
git commit -m "feat(m3-04): add WorkerLeasePort interface"
```

### Task 4: Fake `WorkerLeasePort`

The fake must enforce:

- `acquire` fails with `WorkerLeaseConflictError` if there is an active lease for the same `repoId`.
- `release` is idempotent (releasing a non-existent lease is a no-op).
- `reclaimExpired` only reclaims when **all** ADR-0008 conditions hold:
  1. lease's `heartbeatAt > expiresAt` (i.e. now > expiresAt; heartbeat hasn't refreshed);
  2. owning worker is `stopping` / `unhealthy` OR `isWorkerAlive(workerId) === false`;
  3. lease's `runId` is in `recoverableRunIds`;
  4. `resetWorktree(repoId)` returns without throwing;
  5. then `onReclaimed(...)` is called and the lease is removed.
- Acquire is serialised (use an internal mutex via a `Promise` chain) — for the in-memory fake a simple synchronous check inside one method body is sufficient since JS is single-threaded; document this in a comment.

- [ ] **Step 1: Failing test** — `packages/application/src/__tests__/fake-worker-lease-port.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  RepositoryId,
  RunId,
  WorkerId,
  WorkerLeaseConflictError,
  createWorker,
  markWorkerUnhealthy,
} from '@ai-sdlc/domain';
import { FakeWorkerLeasePort, FakeWorkerRegistryPort } from '../test-doubles/index.js';

const now0 = new Date('2026-01-01T00:00:00Z');

function makePorts() {
  const registry = new FakeWorkerRegistryPort();
  const leases = new FakeWorkerLeasePort(registry);
  return { registry, leases };
}

describe('FakeWorkerLeasePort', () => {
  it('two workers acquiring the same repo concurrently: exactly one wins', () => {
    const { registry, leases } = makePorts();
    registry.register(createWorker({ id: WorkerId('w1'), hostname: 'h', processId: 1, now: now0 }));
    registry.register(createWorker({ id: WorkerId('w2'), hostname: 'h', processId: 2, now: now0 }));
    leases.acquire({
      repoId: RepositoryId('r'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    expect(() =>
      leases.acquire({
        repoId: RepositoryId('r'),
        workerId: WorkerId('w2'),
        runId: RunId('run-2'),
        now: now0,
        ttlMs: 60_000,
      }),
    ).toThrow(WorkerLeaseConflictError);
  });
  it('two workers acquiring different repos: both succeed', () => {
    const { registry, leases } = makePorts();
    registry.register(createWorker({ id: WorkerId('w1'), hostname: 'h', processId: 1, now: now0 }));
    registry.register(createWorker({ id: WorkerId('w2'), hostname: 'h', processId: 2, now: now0 }));
    leases.acquire({
      repoId: RepositoryId('r1'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    leases.acquire({
      repoId: RepositoryId('r2'),
      workerId: WorkerId('w2'),
      runId: RunId('run-2'),
      now: now0,
      ttlMs: 60_000,
    });
    expect(leases.current(RepositoryId('r1'))?.workerId).toBe('w1');
    expect(leases.current(RepositoryId('r2'))?.workerId).toBe('w2');
  });
  it('release is idempotent', () => {
    const { registry, leases } = makePorts();
    registry.register(createWorker({ id: WorkerId('w1'), hostname: 'h', processId: 1, now: now0 }));
    leases.acquire({
      repoId: RepositoryId('r'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    leases.release(RepositoryId('r'), WorkerId('w1'));
    leases.release(RepositoryId('r'), WorkerId('w1')); // no throw
    expect(leases.current(RepositoryId('r'))).toBeUndefined();
  });
  it('reclaimExpired requires heartbeat past expiresAt', () => {
    const { registry, leases } = makePorts();
    registry.register(createWorker({ id: WorkerId('w1'), hostname: 'h', processId: 1, now: now0 }));
    leases.acquire({
      repoId: RepositoryId('r'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    const reclaimed = leases.reclaimExpired({
      now: new Date(now0.getTime() + 30_000), // not yet expired
      recoverableRunIds: new Set([RunId('run-1')]),
      isWorkerAlive: () => false,
      resetWorktree: () => {},
      onReclaimed: () => {},
    });
    expect(reclaimed).toEqual([]);
  });
  it('reclaimExpired requires worker stale or unhealthy', () => {
    const { registry, leases } = makePorts();
    registry.register(createWorker({ id: WorkerId('w1'), hostname: 'h', processId: 1, now: now0 }));
    leases.acquire({
      repoId: RepositoryId('r'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    const reclaimed = leases.reclaimExpired({
      now: new Date(now0.getTime() + 120_000),
      recoverableRunIds: new Set([RunId('run-1')]),
      isWorkerAlive: () => true, // worker still alive and not marked unhealthy/stopping
      resetWorktree: () => {},
      onReclaimed: () => {},
    });
    expect(reclaimed).toEqual([]);
  });
  it('reclaimExpired requires run to be recoverable', () => {
    const { registry, leases } = makePorts();
    registry.register(createWorker({ id: WorkerId('w1'), hostname: 'h', processId: 1, now: now0 }));
    leases.acquire({
      repoId: RepositoryId('r'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    const reclaimed = leases.reclaimExpired({
      now: new Date(now0.getTime() + 120_000),
      recoverableRunIds: new Set(), // run not recoverable
      isWorkerAlive: () => false,
      resetWorktree: () => {},
      onReclaimed: () => {},
    });
    expect(reclaimed).toEqual([]);
  });
  it('reclaimExpired succeeds when all conditions hold and emits onReclaimed', () => {
    const { registry, leases } = makePorts();
    registry.register(createWorker({ id: WorkerId('w1'), hostname: 'h', processId: 1, now: now0 }));
    leases.acquire({
      repoId: RepositoryId('r'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    const onReclaimed = vi.fn();
    const resetWorktree = vi.fn();
    const reclaimed = leases.reclaimExpired({
      now: new Date(now0.getTime() + 120_000),
      recoverableRunIds: new Set([RunId('run-1')]),
      isWorkerAlive: () => false,
      resetWorktree,
      onReclaimed,
    });
    expect(reclaimed).toHaveLength(1);
    expect(resetWorktree).toHaveBeenCalledWith(RepositoryId('r'));
    expect(onReclaimed).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 'r',
        previousWorkerId: 'w1',
        previousRunId: 'run-1',
      }),
    );
    expect(leases.current(RepositoryId('r'))).toBeUndefined();
  });
  it('reclaimExpired succeeds when worker is marked unhealthy even if isWorkerAlive returns true', () => {
    const { registry, leases } = makePorts();
    registry.register(createWorker({ id: WorkerId('w1'), hostname: 'h', processId: 1, now: now0 }));
    registry.markUnhealthy(WorkerId('w1'));
    leases.acquire({
      repoId: RepositoryId('r'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    const reclaimed = leases.reclaimExpired({
      now: new Date(now0.getTime() + 120_000),
      recoverableRunIds: new Set([RunId('run-1')]),
      isWorkerAlive: () => true,
      resetWorktree: () => {},
      onReclaimed: () => {},
    });
    expect(reclaimed).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Implement** — `packages/application/src/test-doubles/fake-worker-lease-port.ts`:

```ts
import {
  type RepositoryId,
  type RunId,
  type WorkerId,
  type WorkerLease,
  WorkerLeaseConflictError,
} from '@ai-sdlc/domain';
import type {
  WorkerLeasePort,
  AcquireLeaseInput,
  ReclaimExpiredInput,
} from '../ports/worker-lease-port.js';
import type { WorkerRegistryPort } from '../ports/worker-registry-port.js';

// NOTE: this fake is synchronous; JavaScript is single-threaded so a single
// method body is effectively atomic. The SQLite adapter must use a uniqueness
// constraint on (repoId) where status='active' to provide the same guarantee.
export class FakeWorkerLeasePort implements WorkerLeasePort {
  private leases = new Map<RepositoryId, WorkerLease>();
  constructor(private readonly registry: WorkerRegistryPort) {}

  acquire(input: AcquireLeaseInput): WorkerLease {
    const existing = this.leases.get(input.repoId);
    if (existing) throw new WorkerLeaseConflictError(input.repoId, existing.workerId);
    const lease: WorkerLease = {
      repoId: input.repoId,
      workerId: input.workerId,
      runId: input.runId,
      acquiredAt: input.now,
      heartbeatAt: input.now,
      expiresAt: new Date(input.now.getTime() + input.ttlMs),
    };
    this.leases.set(input.repoId, lease);
    return lease;
  }

  heartbeat(repoId: RepositoryId, workerId: WorkerId, now: Date, newExpiresAt: Date): void {
    const l = this.leases.get(repoId);
    if (!l || l.workerId !== workerId) return;
    this.leases.set(repoId, { ...l, heartbeatAt: now, expiresAt: newExpiresAt });
  }

  release(repoId: RepositoryId, workerId: WorkerId): void {
    const l = this.leases.get(repoId);
    if (!l || l.workerId !== workerId) return;
    this.leases.delete(repoId);
  }

  current(repoId: RepositoryId): WorkerLease | undefined {
    return this.leases.get(repoId);
  }

  reclaimExpired(input: ReclaimExpiredInput): WorkerLease[] {
    const reclaimed: WorkerLease[] = [];
    for (const lease of [...this.leases.values()]) {
      if (input.now <= lease.expiresAt) continue;
      const worker = this.registry.findById(lease.workerId);
      const workerStale =
        !input.isWorkerAlive(lease.workerId) ||
        worker?.status === 'stopping' ||
        worker?.status === 'unhealthy';
      if (!workerStale) continue;
      if (!input.recoverableRunIds.has(lease.runId)) continue;
      input.resetWorktree(lease.repoId); // may throw; aborts reclaim for this lease
      this.leases.delete(lease.repoId);
      input.onReclaimed({
        repoId: lease.repoId,
        previousWorkerId: lease.workerId,
        previousRunId: lease.runId,
        reason: 'expired + worker stale + run recoverable',
      });
      reclaimed.push(lease);
    }
    return reclaimed;
  }
}
```

- [ ] **Step 3: Export from barrel.** Append to `packages/application/src/test-doubles/index.ts`:

```ts
export * from './fake-worker-registry-port.js';
export * from './fake-worker-lease-port.js';
```

- [ ] **Step 4: Run all tests — expect PASS (all 8 lease tests).**

- [ ] **Step 5: Commit**

```
git add packages/application/src/test-doubles/fake-worker-lease-port.ts packages/application/src/test-doubles/index.ts packages/application/src/__tests__/fake-worker-lease-port.test.ts
git commit -m "test(m3-04): add FakeWorkerLeasePort enforcing one active lease per repo"
```

### Task 5: Concurrency simulation test (acceptance criterion)

- [ ] **Step 1:** Create `packages/application/src/__tests__/worker-concurrency.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  createWorker,
  IssueNumber,
  JobId,
  RepositoryId,
  RunId,
  WorkerId,
  createJob,
  WorkerLeaseConflictError,
} from '@ai-sdlc/domain';
import {
  FakeRepositoryPort,
  FakeJobQueuePort,
  FakeWorkerRegistryPort,
  FakeWorkerLeasePort,
} from '../test-doubles/index.js';

function setup() {
  const repos = new FakeRepositoryPort([
    {
      id: RepositoryId('r1'),
      owner: 'o',
      name: 'r1',
      fullName: 'o/r1',
      defaultBranch: 'main',
      localBasePath: '/x',
      enabled: true,
      maxConcurrentRuns: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: RepositoryId('r2'),
      owner: 'o',
      name: 'r2',
      fullName: 'o/r2',
      defaultBranch: 'main',
      localBasePath: '/y',
      enabled: true,
      maxConcurrentRuns: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);
  const queue = new FakeJobQueuePort(repos);
  const registry = new FakeWorkerRegistryPort();
  const leases = new FakeWorkerLeasePort(registry);
  const now = new Date();
  registry.register(createWorker({ id: WorkerId('w1'), hostname: 'h', processId: 1, now }));
  registry.register(createWorker({ id: WorkerId('w2'), hostname: 'h', processId: 2, now }));
  return { repos, queue, registry, leases, now };
}

describe('worker concurrency simulation', () => {
  it('two queued jobs on the same repo: workers serialise (one acquires, the other blocks)', () => {
    const { queue, leases, now } = setup();
    queue.enqueue({
      job: createJob({
        id: JobId('j1'),
        runId: RunId('run-1'),
        repoId: RepositoryId('r1'),
        issueNumber: IssueNumber(1),
        createdAt: now,
      }),
    });
    queue.enqueue({
      job: createJob({
        id: JobId('j2'),
        runId: RunId('run-2'),
        repoId: RepositoryId('r1'),
        issueNumber: IssueNumber(2),
        createdAt: new Date(now.getTime() + 1000),
      }),
    });
    const j1 = queue.claimNext({ workerId: WorkerId('w1') })!;
    leases.acquire({
      repoId: j1.repoId,
      workerId: WorkerId('w1'),
      runId: j1.runId,
      now,
      ttlMs: 60_000,
    });
    const j2 = queue.claimNext({ workerId: WorkerId('w2') })!;
    expect(() =>
      leases.acquire({
        repoId: j2.repoId,
        workerId: WorkerId('w2'),
        runId: j2.runId,
        now,
        ttlMs: 60_000,
      }),
    ).toThrow(WorkerLeaseConflictError);
  });

  it('two queued jobs on different repos: both workers run concurrently', () => {
    const { queue, leases, now } = setup();
    queue.enqueue({
      job: createJob({
        id: JobId('j1'),
        runId: RunId('run-1'),
        repoId: RepositoryId('r1'),
        issueNumber: IssueNumber(1),
        createdAt: now,
      }),
    });
    queue.enqueue({
      job: createJob({
        id: JobId('j2'),
        runId: RunId('run-2'),
        repoId: RepositoryId('r2'),
        issueNumber: IssueNumber(2),
        createdAt: now,
      }),
    });
    const j1 = queue.claimNext({ workerId: WorkerId('w1') })!;
    const j2 = queue.claimNext({ workerId: WorkerId('w2') })!;
    leases.acquire({
      repoId: j1.repoId,
      workerId: WorkerId('w1'),
      runId: j1.runId,
      now,
      ttlMs: 60_000,
    });
    leases.acquire({
      repoId: j2.repoId,
      workerId: WorkerId('w2'),
      runId: j2.runId,
      now,
      ttlMs: 60_000,
    });
    expect(leases.current(RepositoryId('r1'))?.workerId).toBe('w1');
    expect(leases.current(RepositoryId('r2'))?.workerId).toBe('w2');
  });
});
```

- [ ] **Step 2: Commit**

```
git add packages/application/src/__tests__/worker-concurrency.test.ts
git commit -m "test(m3-04): concurrency simulation — exactly one worker wins lease per repo"
```

- [ ] **Step 3: Final verification.** `pnpm -r typecheck && pnpm -r test --run && pnpm lint && pnpm depcruise`. All work is already committed via per-task commits. The orchestrator handles push + PR.

---

## Story M3-05 — Application use case interfaces

**PR scope:** Declare the use-case **interfaces** (no implementation yet) and the non-agent infrastructure ports (`EventBus`, `GitHubPort`, `GitPort`, `ValidationPort`, `ArtifactStore`) that M4–M8 will implement. Provide minimal in-memory fakes for each new port. `StartIssueRun` interface is updated to document that it must enqueue a Job, but the **existing concrete `StartIssueRun` class** stays as-is for now — M8 wires it onto the queue.

**Files:**

- Create: `packages/application/src/use-cases.ts` (interface-only file)
- Create: `packages/application/src/ports/github-port.ts`
- Create: `packages/application/src/ports/git-port.ts`
- Create: `packages/application/src/ports/validation-port.ts`
- Create: `packages/application/src/ports/artifact-store.ts`
- Modify: `packages/application/src/ports.ts` (re-export new ports)
- Create: `packages/application/src/test-doubles/fake-github-port.ts`
- Create: `packages/application/src/test-doubles/fake-git-port.ts`
- Create: `packages/application/src/test-doubles/fake-validation-port.ts`
- Create: `packages/application/src/test-doubles/fake-artifact-store.ts`
- Modify: `packages/application/src/test-doubles/index.ts`
- Modify: `packages/application/src/index.ts` (export `use-cases`)
- Create one smoke test that imports every new fake and asserts it can be instantiated.

### Task 1: Define use-case interfaces

- [ ] **Step 1: Create** `packages/application/src/use-cases.ts`:

```ts
import type { RepositoryId, IssueNumber, RunId, JobId, WorkerId } from '@ai-sdlc/domain';

export interface StartIssueRunUseCase {
  /** Enqueues a Job; never executes the phase pipeline inline. */
  execute(input: {
    repoId: RepositoryId;
    issueNumber: IssueNumber;
  }): Promise<{ runId: RunId; jobId: JobId }>;
}

export interface ResumeRunUseCase {
  execute(input: { runId: RunId; fromPhase?: string }): Promise<void>;
}

export interface RetryFailedPhaseUseCase {
  execute(input: { runId: RunId }): Promise<void>;
}

export interface CancelRunUseCase {
  execute(input: { runId: RunId; reason?: string }): Promise<void>;
}

export interface ClaimNextJobUseCase {
  execute(input: { workerId: WorkerId }): Promise<{ jobId: JobId } | undefined>;
}

export interface AcquireRepoLeaseUseCase {
  execute(input: { workerId: WorkerId; jobId: JobId }): Promise<void>;
}

export interface ReleaseRepoLeaseUseCase {
  execute(input: { workerId: WorkerId; repoId: RepositoryId }): Promise<void>;
}

// Below are agent-related use cases declared as interfaces here so M4 has
// somewhere to land. They depend on AgentPort (M3-06).
export interface RunAgentWithContractUseCase {
  execute(input: {
    runId: RunId;
    phaseName: string;
    profileName: string;
  }): Promise<{ ok: boolean }>;
}

export interface RunValidationUseCase {
  execute(input: { runId: RunId }): Promise<{ ok: boolean }>;
}

export interface ProcessPrReviewCommentsUseCase {
  execute(input: { runId: RunId }): Promise<{ processed: number }>;
}

export interface CreatePullRequestUseCase {
  execute(input: { runId: RunId }): Promise<{ prUrl: string }>;
}
```

- [ ] **Step 2:** Add `export * from './use-cases.js';` to `packages/application/src/index.ts`.

- [ ] **Step 3: Commit**

```
git add packages/application/src/use-cases.ts packages/application/src/index.ts
git commit -m "feat(m3-05): add application use-case interfaces"
```

### Task 2: Non-agent ports (signatures only — agent port is M3-06)

For each port, keep the surface minimal — we only need what M3 acceptance asserts compiles. Detail can be added by later milestones.

- [ ] **Step 1:** Create `packages/application/src/ports/github-port.ts`:

```ts
export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
}

export interface PullRequest {
  number: number;
  url: string;
  state: 'open' | 'closed' | 'merged';
}

export interface PrReviewComment {
  id: number;
  prNumber: number;
  path: string;
  line: number;
  reviewer: string;
  body: string;
  createdAt: Date;
}

export interface CreatePullRequestInput {
  repoFullName: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
  draft?: boolean;
}

export interface GitHubPort {
  getIssue(repoFullName: string, issueNumber: number): Promise<GitHubIssue>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequest>;
  listReviewComments(repoFullName: string, prNumber: number): Promise<PrReviewComment[]>;
  replyToReviewComment(
    repoFullName: string,
    prNumber: number,
    commentId: number,
    body: string,
  ): Promise<void>;
  updateIssueLabels(
    repoFullName: string,
    issueNumber: number,
    labels: { add?: string[]; remove?: string[] },
  ): Promise<void>;
}
```

- [ ] **Step 2:** Create `packages/application/src/ports/git-port.ts`:

```ts
export interface CreateWorktreeInput {
  repoLocalBasePath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
}

export interface PushInput {
  cwd: string;
  branch: string;
  remote?: string;
}

export interface GitPort {
  createWorktree(input: CreateWorktreeInput): Promise<void>;
  removeWorktree(worktreePath: string): Promise<void>;
  currentBranch(cwd: string): Promise<string>;
  headCommitSha(cwd: string): Promise<string>;
  resetHard(cwd: string, commitSha: string): Promise<void>;
  diff(cwd: string, base: string, head?: string): Promise<string>;
  commit(cwd: string, message: string): Promise<string>;
  push(input: PushInput): Promise<void>;
}
```

- [ ] **Step 3:** Create `packages/application/src/ports/validation-port.ts`:

```ts
export interface ValidationCommandResult {
  command: string;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface RunValidationInput {
  cwd: string;
  commands: string[];
  timeoutSeconds: number;
}

export interface ValidationPort {
  run(input: RunValidationInput): Promise<ValidationCommandResult[]>;
}
```

- [ ] **Step 4:** Create `packages/application/src/ports/artifact-store.ts`:

```ts
export interface WriteArtifactInput {
  runId: string;
  phaseId?: string;
  relativePath: string; // e.g. "phases/plan-design/attempt-1/design.md"
  contents: string | Uint8Array;
}

export interface Artifact {
  runId: string;
  phaseId?: string;
  relativePath: string;
  absolutePath: string;
  bytes: number;
  createdAt: Date;
}

export interface ArtifactStore {
  write(input: WriteArtifactInput): Promise<Artifact>;
  read(runId: string, relativePath: string): Promise<string>;
  list(runId: string): Promise<Artifact[]>;
}
```

- [ ] **Step 5:** Re-export the four ports from `packages/application/src/ports.ts`:

```ts
export type {
  GitHubPort,
  GitHubIssue,
  PullRequest,
  PrReviewComment,
  CreatePullRequestInput,
} from './ports/github-port.js';
export type { GitPort, CreateWorktreeInput, PushInput } from './ports/git-port.js';
export type {
  ValidationPort,
  RunValidationInput,
  ValidationCommandResult,
} from './ports/validation-port.js';
export type { ArtifactStore, WriteArtifactInput, Artifact } from './ports/artifact-store.js';
```

- [ ] **Step 6: Typecheck**

Run: `pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```
git add packages/application/src/ports/github-port.ts packages/application/src/ports/git-port.ts packages/application/src/ports/validation-port.ts packages/application/src/ports/artifact-store.ts packages/application/src/ports.ts
git commit -m "feat(m3-05): add GitHubPort, GitPort, ValidationPort, ArtifactStore interfaces"
```

### Task 3: In-memory fakes for each port

Each fake gets ~30 lines. Implement them as straightforward `Map`-backed objects. Example for `FakeArtifactStore`:

- [ ] **Step 1:** Create `packages/application/src/test-doubles/fake-artifact-store.ts`:

```ts
import type { ArtifactStore, WriteArtifactInput, Artifact } from '../ports/artifact-store.js';

export class FakeArtifactStore implements ArtifactStore {
  private files = new Map<string, { artifact: Artifact; contents: string | Uint8Array }>();
  async write(input: WriteArtifactInput): Promise<Artifact> {
    const key = `${input.runId}/${input.relativePath}`;
    const bytes =
      typeof input.contents === 'string'
        ? Buffer.byteLength(input.contents)
        : input.contents.byteLength;
    const artifact: Artifact = {
      runId: input.runId,
      phaseId: input.phaseId,
      relativePath: input.relativePath,
      absolutePath: `mem://${key}`,
      bytes,
      createdAt: new Date(),
    };
    this.files.set(key, { artifact, contents: input.contents });
    return artifact;
  }
  async read(runId: string, relativePath: string): Promise<string> {
    const entry = this.files.get(`${runId}/${relativePath}`);
    if (!entry) throw new Error(`no artifact ${runId}/${relativePath}`);
    return typeof entry.contents === 'string'
      ? entry.contents
      : Buffer.from(entry.contents).toString('utf8');
  }
  async list(runId: string): Promise<Artifact[]> {
    return [...this.files.values()]
      .filter((e) => e.artifact.runId === runId)
      .map((e) => e.artifact);
  }
}
```

- [ ] **Step 2:** Implement `FakeGitHubPort`, `FakeGitPort`, `FakeValidationPort` following the same pattern. Each method may return canned values driven by public mutable arrays the test sets first. For `FakeGitHubPort`, expose `issues = new Map<number, GitHubIssue>()` and `comments = new Map<number, PrReviewComment[]>()`; for `FakeGitPort`, expose `currentBranchByCwd = new Map<string, string>()` and `headByCwd = new Map<string, string>()`; for `FakeValidationPort`, expose `result: ValidationCommandResult[] = []` returned verbatim. Throw for un-stubbed calls so tests fail loudly.

  Example `FakeGitHubPort` skeleton:

  ```ts
  import type {
    GitHubPort,
    GitHubIssue,
    PullRequest,
    PrReviewComment,
    CreatePullRequestInput,
  } from '../ports/github-port.js';
  export class FakeGitHubPort implements GitHubPort {
    issues = new Map<string, GitHubIssue>(); // key = "repo/number"
    comments = new Map<string, PrReviewComment[]>(); // key = "repo/prNumber"
    repliesPosted: Array<{ commentId: number; body: string }> = [];
    labelChanges: Array<{
      repoFullName: string;
      issueNumber: number;
      add?: string[];
      remove?: string[];
    }> = [];
    createdPrs: PullRequest[] = [];
    async getIssue(repo: string, n: number) {
      const i = this.issues.get(`${repo}/${n}`);
      if (!i) throw new Error(`no issue ${repo}#${n}`);
      return i;
    }
    async createPullRequest(input: CreatePullRequestInput) {
      const pr: PullRequest = {
        number: this.createdPrs.length + 1,
        url: `https://example/pr/${this.createdPrs.length + 1}`,
        state: 'open',
      };
      this.createdPrs.push(pr);
      return pr;
    }
    async listReviewComments(repo: string, n: number) {
      return this.comments.get(`${repo}/${n}`) ?? [];
    }
    async replyToReviewComment(_r: string, _p: number, commentId: number, body: string) {
      this.repliesPosted.push({ commentId, body });
    }
    async updateIssueLabels(
      repoFullName: string,
      issueNumber: number,
      labels: { add?: string[]; remove?: string[] },
    ) {
      this.labelChanges.push({ repoFullName, issueNumber, ...labels });
    }
  }
  ```

- [ ] **Step 3:** Export all from `packages/application/src/test-doubles/index.ts`.

- [ ] **Step 4: Smoke test** — `packages/application/src/__tests__/test-doubles-smoke.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  FakeRepositoryPort,
  FakeJobQueuePort,
  FakeWorkerRegistryPort,
  FakeWorkerLeasePort,
  FakeGitHubPort,
  FakeGitPort,
  FakeValidationPort,
  FakeArtifactStore,
} from '../test-doubles/index.js';

describe('test-doubles barrel', () => {
  it('every fake instantiates', () => {
    const repos = new FakeRepositoryPort([]);
    const registry = new FakeWorkerRegistryPort();
    expect(new FakeJobQueuePort(repos)).toBeDefined();
    expect(new FakeWorkerLeasePort(registry)).toBeDefined();
    expect(new FakeGitHubPort()).toBeDefined();
    expect(new FakeGitPort()).toBeDefined();
    expect(new FakeValidationPort()).toBeDefined();
    expect(new FakeArtifactStore()).toBeDefined();
  });
});
```

Run + expect PASS.

- [ ] **Step 5: Commit**

```
git add packages/application/src/test-doubles/fake-github-port.ts packages/application/src/test-doubles/fake-git-port.ts packages/application/src/test-doubles/fake-validation-port.ts packages/application/src/test-doubles/fake-artifact-store.ts packages/application/src/test-doubles/index.ts packages/application/src/__tests__/test-doubles-smoke.test.ts
git commit -m "test(m3-05): add in-memory fakes for GitHub/Git/Validation/Artifact ports"
```

### Task 4: Final verification

- [ ] **Step 1:** `pnpm -r typecheck && pnpm -r test --run && pnpm lint && pnpm depcruise`.
- [ ] **Step 2: Stop.** All work is already committed via per-task commits. The orchestrator handles push + PR.

---

## Story M3-06 — Runtime-agnostic `AgentPort` and profiles

**PR scope:** Add `AgentRuntimeKind`, `AgentProfile`, `AgentProfileName`, the `AgentPort` interface, and a `FakeAgentPort` that records every invocation and lets tests script per-profile responses (success / contract violation / timeout / fallback-trigger). Pure types live in `packages/application` (request/result are also pure but kept in application for now per the PRD note).

**Files:**

- Create: `packages/application/src/agent/types.ts`
- Create: `packages/application/src/ports/agent-port.ts`
- Create: `packages/application/src/test-doubles/fake-agent-port.ts`
- Modify: `packages/application/src/test-doubles/index.ts`
- Modify: `packages/application/src/ports.ts`
- Modify: `packages/application/src/index.ts` (export `agent/types`)
- Create tests.

### Task 1: `AgentRuntimeKind`, `AgentProfile`, type guards

- [ ] **Step 1: Failing test** — `packages/application/src/__tests__/agent-types.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  type AgentProfile,
  type AgentProfileName,
  isOpencodeProfile,
  isPiProfile,
  validateAgentProfile,
} from '../agent/types.js';

const opencode: AgentProfile = {
  runtime: 'opencode',
  provider: 'anthropic',
  model: 'claude-opus-4.7',
  timeoutMinutes: 60,
};
const pi: AgentProfile = {
  runtime: 'pi',
  provider: 'local',
  model: 'qwen3.6-27b',
  contextLimitTokens: 64_000,
  promptBudgetTokens: 40_000,
  outputBudgetTokens: 8_000,
  timeoutMinutes: 30,
};

describe('AgentProfile type guards', () => {
  it('isOpencodeProfile / isPiProfile', () => {
    expect(isOpencodeProfile(opencode)).toBe(true);
    expect(isPiProfile(opencode)).toBe(false);
    expect(isPiProfile(pi)).toBe(true);
  });
  it('validateAgentProfile accepts well-formed profiles', () => {
    expect(() =>
      validateAgentProfile('opencode-frontier' as AgentProfileName, opencode),
    ).not.toThrow();
    expect(() => validateAgentProfile('pi-qwen' as AgentProfileName, pi)).not.toThrow();
  });
  it('validateAgentProfile rejects Pi profile missing contextLimitTokens', () => {
    expect(() =>
      validateAgentProfile('pi-bad' as AgentProfileName, {
        ...pi,
        contextLimitTokens: undefined as unknown as number,
      }),
    ).toThrow(/contextLimitTokens/);
  });
  it('validateAgentProfile rejects non-positive timeoutMinutes', () => {
    expect(() =>
      validateAgentProfile('x' as AgentProfileName, { ...opencode, timeoutMinutes: 0 }),
    ).toThrow(/timeoutMinutes/);
  });
});
```

- [ ] **Step 2: Implement** — `packages/application/src/agent/types.ts`:

```ts
export type AgentRuntimeKind = 'opencode' | 'pi';

export type AgentProfileName = string & { readonly __brand: 'AgentProfileName' };
export function AgentProfileName(v: string): AgentProfileName {
  if (typeof v !== 'string' || v.length === 0)
    throw new Error('AgentProfileName must be non-empty');
  return v as AgentProfileName;
}

export interface AgentProfile {
  runtime: AgentRuntimeKind;
  provider: string;
  model: string;
  contextLimitTokens?: number;
  promptBudgetTokens?: number;
  outputBudgetTokens?: number;
  timeoutMinutes: number;
}

export function isOpencodeProfile(p: AgentProfile): boolean {
  return p.runtime === 'opencode';
}
export function isPiProfile(p: AgentProfile): boolean {
  return p.runtime === 'pi';
}

export function validateAgentProfile(name: AgentProfileName, p: AgentProfile): void {
  if (!p.timeoutMinutes || p.timeoutMinutes <= 0) {
    throw new Error(`profile ${name}: timeoutMinutes must be a positive number`);
  }
  if (p.runtime === 'pi') {
    if (!p.contextLimitTokens || p.contextLimitTokens <= 0) {
      throw new Error(`profile ${name}: pi profiles require positive contextLimitTokens`);
    }
  }
}

export interface PhaseRoutingEntry {
  profile: AgentProfileName;
  fallbackProfile?: AgentProfileName;
}
```

- [ ] **Step 3:** Export from `packages/application/src/index.ts`:

```ts
export * from './agent/types.js';
```

- [ ] **Step 4: Run tests — expect PASS.**

- [ ] **Step 5: Commit**

```
git add packages/application/src/agent/types.ts packages/application/src/__tests__/agent-types.test.ts packages/application/src/index.ts
git commit -m "feat(m3-06): add AgentRuntimeKind, AgentProfile, and type guards"
```

### Task 2: `AgentInvocationRequest` / `AgentInvocationResult` (covers M3-07; merging M3-06 + M3-07 here keeps the PR coherent — see "Note on M3-07" at end)

We split M3-06 and M3-07 into **two PRs** for the milestone-stories doc, but a single agent type module is easier to maintain. Implement request/result here too; the M3-07 PR becomes a no-op rename or is deferred. **For the autonomous loop: keep M3-06 strictly to the profile + AgentPort + FakeAgentPort, and put the request/result types in M3-07.** Below is the M3-06-only AgentPort that depends on the request/result types created in M3-07 — meaning M3-06 cannot land before M3-07 in the autonomous loop. **Reorder accordingly: implement M3-07 first, then M3-06.** (See "Story ordering note" at the very end.)

Skip to Task 3.

### Task 3: `AgentPort` interface

> Depends on `AgentInvocationRequest` / `AgentInvocationResult` from M3-07. If M3-07 has not landed, stop and execute that story first.

- [ ] **Step 1:** Create `packages/application/src/ports/agent-port.ts`:

```ts
import type { AgentInvocationRequest, AgentInvocationResult } from '../agent/invocation.js';

export interface AgentPort {
  invoke(input: AgentInvocationRequest): Promise<AgentInvocationResult>;
}
```

- [ ] **Step 2:** Re-export from `ports.ts`:

```ts
export type { AgentPort } from './ports/agent-port.js';
```

- [ ] **Step 3: Commit**

```
git add packages/application/src/ports/agent-port.ts packages/application/src/ports.ts
git commit -m "feat(m3-06): add AgentPort interface"
```

### Task 4: `FakeAgentPort`

The fake must:

- Record every `invoke(...)` request in a public `invocations: AgentInvocationRequest[]` array.
- Look up a per-profile script provided at construction time: `Map<AgentProfileName, Array<AgentInvocationResult | ((req) => AgentInvocationResult)>>`.
- Pop the next scripted response for that profile and return it (FIFO). If no response is scripted for the requested profile, throw.

- [ ] **Step 1: Test** — `packages/application/src/__tests__/fake-agent-port.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AgentProfileName } from '../agent/types.js';
import type { AgentInvocationRequest, AgentInvocationResult } from '../agent/invocation.js';
import { FakeAgentPort } from '../test-doubles/index.js';

function req(profile: string): AgentInvocationRequest {
  return {
    profile: AgentProfileName(profile),
    promptPath: '/tmp/prompt.md',
    expectedArtifacts: ['design.md'],
    cwd: '/tmp/wt',
    runId: 'run-1',
    repoId: 'repo-1',
    phaseId: 'phase-1',
  };
}

function ok(profile: string, model: string): AgentInvocationResult {
  return {
    runtime: profile.startsWith('pi') ? 'pi' : 'opencode',
    provider: 'x',
    model,
    exitCode: 0,
    durationMs: 1000,
    stdoutPath: '/tmp/stdout.log',
    stderrPath: '/tmp/stderr.log',
    contractViolations: [],
    outcome: 'success',
  };
}

describe('FakeAgentPort', () => {
  it('returns scripted responses in FIFO order per profile', async () => {
    const fake = new FakeAgentPort({
      [AgentProfileName('opencode-frontier')]: [
        ok('opencode-frontier', 'm1'),
        ok('opencode-frontier', 'm2'),
      ],
    });
    const a = await fake.invoke(req('opencode-frontier'));
    const b = await fake.invoke(req('opencode-frontier'));
    expect(a.model).toBe('m1');
    expect(b.model).toBe('m2');
    expect(fake.invocations).toHaveLength(2);
  });
  it('throws when no scripted response remains', async () => {
    const fake = new FakeAgentPort({});
    await expect(fake.invoke(req('opencode-frontier'))).rejects.toThrow(/no scripted response/);
  });
  it('supports a callable response (for per-request behavior)', async () => {
    const fake = new FakeAgentPort({
      [AgentProfileName('pi-qwen')]: [
        (r) => ({ ...ok('pi-qwen', 'qwen'), contractViolations: [r.profile] }),
      ],
    });
    const result = await fake.invoke(req('pi-qwen'));
    expect(result.contractViolations).toEqual(['pi-qwen']);
  });
});
```

- [ ] **Step 2: Implement** — `packages/application/src/test-doubles/fake-agent-port.ts`:

```ts
import type { AgentPort } from '../ports/agent-port.js';
import type { AgentInvocationRequest, AgentInvocationResult } from '../agent/invocation.js';
import type { AgentProfileName } from '../agent/types.js';

export type FakeAgentResponse =
  | AgentInvocationResult
  | ((req: AgentInvocationRequest) => AgentInvocationResult);

export class FakeAgentPort implements AgentPort {
  invocations: AgentInvocationRequest[] = [];
  private script: Map<AgentProfileName, FakeAgentResponse[]>;
  constructor(script: Partial<Record<AgentProfileName, FakeAgentResponse[]>>) {
    this.script = new Map(
      Object.entries(script).map(([k, v]) => [k as AgentProfileName, [...(v ?? [])]]),
    );
  }
  async invoke(input: AgentInvocationRequest): Promise<AgentInvocationResult> {
    this.invocations.push(input);
    const queue = this.script.get(input.profile);
    if (!queue || queue.length === 0) {
      throw new Error(`no scripted response for profile ${input.profile}`);
    }
    const next = queue.shift()!;
    return typeof next === 'function' ? next(input) : next;
  }
}
```

- [ ] **Step 3:** Export from `packages/application/src/test-doubles/index.ts`.

- [ ] **Step 4: Run tests — expect PASS.**

- [ ] **Step 5: Commit**

```
git add packages/application/src/test-doubles/fake-agent-port.ts packages/application/src/test-doubles/index.ts packages/application/src/__tests__/fake-agent-port.test.ts
git commit -m "test(m3-06): add FakeAgentPort with FIFO per-profile scripted responses"
```

### Task 5: Layer-boundary regression test

- [ ] **Step 1:** `pnpm depcruise` should still pass — no application file should import `@ai-sdlc/infrastructure` or `child_process`. If depcruise fails, you imported the wrong thing.

(No commit step here — this task only runs an existing check; nothing to stage.)

### Task 6: Final verification

- [ ] **Step 1:** `pnpm -r typecheck && pnpm -r test --run && pnpm lint && pnpm depcruise`.
- [ ] **Step 2: Stop.** All work is already committed via per-task commits. The orchestrator handles push + PR.

---

## Story M3-07 — `AgentInvocationRequest` / `AgentInvocationResult` contracts

**PR scope (must land before M3-06):** Add the request/result types only. They are pure data — no port or fake yet.

**Files:**

- Create: `packages/application/src/agent/invocation.ts`
- Modify: `packages/application/src/index.ts`
- Create: `packages/application/src/__tests__/agent-invocation.test.ts`

### Task 1: Types

- [ ] **Step 1: Failing test:**

```ts
import { describe, expect, it } from 'vitest';
import type { AgentInvocationRequest, AgentInvocationResult } from '../agent/invocation.js';
import { AgentProfileName } from '../agent/types.js';

describe('AgentInvocation types compile', () => {
  it('round-trips a minimal request and result', () => {
    const req: AgentInvocationRequest = {
      profile: AgentProfileName('opencode-frontier'),
      promptPath: '/tmp/p.md',
      expectedArtifacts: ['plan.md'],
      cwd: '/tmp/wt',
      runId: 'r1',
      repoId: 'repo1',
      phaseId: 'plan-design',
    };
    const res: AgentInvocationResult = {
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-opus-4.7',
      exitCode: 0,
      durationMs: 1234,
      stdoutPath: '/tmp/o.log',
      stderrPath: '/tmp/e.log',
      contractViolations: [],
      outcome: 'success',
    };
    expect(req.profile).toBe('opencode-frontier');
    expect(res.outcome).toBe('success');
  });
});
```

- [ ] **Step 2: Implement** — `packages/application/src/agent/invocation.ts`:

```ts
import type { AgentProfileName, AgentRuntimeKind } from './types.js';

export interface AgentInvocationRequest {
  profile: AgentProfileName;
  promptPath: string;
  expectedArtifacts: string[];
  cwd: string;
  runId: string;
  repoId: string;
  workerId?: string;
  phaseId: string;
  stepId?: string;
}

export type AgentInvocationOutcome = 'success' | 'failed' | 'timeout' | 'contract_violation';

export interface AgentInvocationResult {
  runtime: AgentRuntimeKind;
  provider: string;
  model: string;
  exitCode: number;
  durationMs: number;
  stdoutPath: string;
  stderrPath: string;
  resultJsonPath?: string;
  contractViolations: string[];
  outcome: AgentInvocationOutcome;
}
```

- [ ] **Step 3:** Export from `packages/application/src/index.ts`:

```ts
export * from './agent/invocation.js';
```

- [ ] **Step 4: Run tests — expect PASS.**

- [ ] **Step 5: Commit**

```
git add packages/application/src/agent/invocation.ts packages/application/src/__tests__/agent-invocation.test.ts packages/application/src/index.ts
git commit -m "feat(m3-07): add AgentInvocationRequest and AgentInvocationResult types"
```

### Task 2: Final verification

- [ ] **Step 1:** `pnpm -r typecheck && pnpm -r test --run && pnpm lint && pnpm depcruise`.
- [ ] **Step 2: Stop.** All work is already committed via per-task commits. The orchestrator handles push + PR.

---

## Story M3-08 — Agent config schema in `.ai-orchestrator.json`

**PR scope:** Extend the Zod config schema in `@ai-sdlc/shared` with an `agent` section (`defaultProfile`, `profiles`, `phaseProfiles`). Wire `loadConfig` to return the typed `AgentConfig`. Reject dangling references with a precise `ConfigError`. Update the sample `.ai-orchestrator.json`.

**Files:**

- Modify: `packages/shared/src/config/schema.ts`
- Modify: `packages/shared/src/config/loader.ts` (if it post-processes)
- Modify: `.ai-orchestrator.json`
- Create: `packages/shared/src/__tests__/agent-config.test.ts`

### Task 1: Extend Zod schema

- [ ] **Step 1:** Read existing `packages/shared/src/config/schema.ts` and `loader.ts`. Note current `ConfigError` shape (`packages/shared/src/config/errors.ts`).

- [ ] **Step 2: Failing test** — `packages/shared/src/__tests__/agent-config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { orchestratorConfigSchema } from '../config/schema.js';

const baseValid = {
  validation: { commands: ['pnpm test'], timeout: 60 },
  phases: { skip: [], reviewFix: { maxIterations: 10 }, implement: { maxIterations: 5 } },
  timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
  agent: {
    defaultProfile: 'opencode-frontier',
    profiles: {
      'opencode-frontier': {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-opus-4.7',
        timeoutMinutes: 60,
      },
      'pi-qwen-local': {
        runtime: 'pi',
        provider: 'local',
        model: 'qwen3.6-27b',
        contextLimitTokens: 64000,
        promptBudgetTokens: 40000,
        outputBudgetTokens: 8000,
        timeoutMinutes: 30,
      },
    },
    phaseProfiles: {
      'plan-design': { profile: 'opencode-frontier' },
      implement: { profile: 'pi-qwen-local', fallbackProfile: 'opencode-frontier' },
    },
  },
};

describe('agent config schema', () => {
  it('accepts a valid agent config', () => {
    expect(() => orchestratorConfigSchema.parse(baseValid)).not.toThrow();
  });
  it('rejects an unknown runtime', () => {
    const bad = structuredClone(baseValid);
    (bad.agent.profiles['opencode-frontier'] as { runtime: string }).runtime = 'banana';
    expect(() => orchestratorConfigSchema.parse(bad)).toThrow(/runtime/);
  });
  it('rejects phaseProfiles referencing an unknown profile', () => {
    const bad = structuredClone(baseValid);
    bad.agent.phaseProfiles['plan-design'].profile = 'missing-profile';
    expect(() => orchestratorConfigSchema.parse(bad)).toThrow(
      /phaseProfiles\.plan-design\.profile/,
    );
  });
  it('rejects phaseProfiles referencing an unknown fallbackProfile', () => {
    const bad = structuredClone(baseValid);
    bad.agent.phaseProfiles['implement'].fallbackProfile = 'no-such-profile';
    expect(() => orchestratorConfigSchema.parse(bad)).toThrow(/fallbackProfile/);
  });
  it('rejects defaultProfile that is not in profiles', () => {
    const bad = structuredClone(baseValid);
    bad.agent.defaultProfile = 'nope';
    expect(() => orchestratorConfigSchema.parse(bad)).toThrow(/defaultProfile/);
  });
  it('rejects pi profile missing contextLimitTokens', () => {
    const bad = structuredClone(baseValid);
    delete (bad.agent.profiles['pi-qwen-local'] as Record<string, unknown>).contextLimitTokens;
    expect(() => orchestratorConfigSchema.parse(bad)).toThrow(/contextLimitTokens/);
  });
});
```

- [ ] **Step 3: Run — expect fail.**

- [ ] **Step 4: Extend** `packages/shared/src/config/schema.ts`:

```ts
import { z } from 'zod';

const validationSchema = z.object({
  commands: z.array(z.string().min(1)).min(1),
  timeout: z.number().int().positive(),
});

const phasesSchema = z.object({
  skip: z.array(z.string()).default([]),
  reviewFix: z.object({ maxIterations: z.number().int().positive() }),
  implement: z.object({ maxIterations: z.number().int().positive() }),
});

const timeoutsSchema = z.object({
  readyMaxDays: z.number().int().positive(),
  invocationMaxMinutes: z.number().int().positive(),
});

const agentRuntime = z.enum(['opencode', 'pi']);

const agentProfileSchema = z
  .object({
    runtime: agentRuntime,
    provider: z.string().min(1),
    model: z.string().min(1),
    contextLimitTokens: z.number().int().positive().optional(),
    promptBudgetTokens: z.number().int().positive().optional(),
    outputBudgetTokens: z.number().int().positive().optional(),
    timeoutMinutes: z.number().positive(),
  })
  .superRefine((p, ctx) => {
    if (p.runtime === 'pi' && p.contextLimitTokens === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contextLimitTokens'],
        message: 'pi profiles require contextLimitTokens',
      });
    }
  });

const phaseProfileEntrySchema = z.object({
  profile: z.string().min(1),
  fallbackProfile: z.string().min(1).optional(),
});

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

export const orchestratorConfigSchema = z.object({
  validation: validationSchema,
  phases: phasesSchema,
  timeouts: timeoutsSchema,
  agent: agentSchema.optional(), // optional in MVP; M4 starts requiring it
});

export type OrchestratorConfig = z.infer<typeof orchestratorConfigSchema>;
export type AgentConfig = NonNullable<OrchestratorConfig['agent']>;
```

- [ ] **Step 5: Run tests — expect PASS.**

- [ ] **Step 6: Commit**

```
git add packages/shared/src/config/schema.ts packages/shared/src/__tests__/agent-config.test.ts
git commit -m "feat(m3-08): extend Zod config schema with agent profiles and phaseProfiles"
```

### Task 2: Update sample config

- [ ] **Step 1:** Edit `.ai-orchestrator.json` at the repo root and add the `agent` block per PRD §15.7 (copy the JSON example verbatim from PRD §15.7). Keep existing top-level keys intact.

- [ ] **Step 2: Verify the sample parses** — add an integration test in `packages/shared/src/__tests__/agent-config.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

it('the committed .ai-orchestrator.json parses', () => {
  const text = readFileSync(join(process.cwd(), '../..', '.ai-orchestrator.json'), 'utf8');
  expect(() => orchestratorConfigSchema.parse(JSON.parse(text))).not.toThrow();
});
```

(If the relative path resolution fails in your monorepo runner, replace `process.cwd(), '../..'` with the absolute path detection used in other shared tests — check `packages/shared/src/__tests__` for the existing convention before pasting.)

- [ ] **Step 3: Commit**

```
git add .ai-orchestrator.json packages/shared/src/__tests__/agent-config.test.ts
git commit -m "feat(m3-08): add agent block to sample .ai-orchestrator.json and assert it parses"
```

### Task 3: Final verification

- [ ] **Step 1:** `pnpm -r typecheck && pnpm -r test --run && pnpm lint && pnpm depcruise`.
- [ ] **Step 2: Stop.** All work is already committed via per-task commits. The orchestrator handles push + PR.

---

## Story M3-09 — Existing adapters wired to ports

**PR scope:** This is a refactor PR. Move the M1 SQLite repositories and the Bash invocation adapter so they explicitly `implements` the M3 ports added in M3-02..M3-05. **No behavioural change.** Existing tests must still pass.

**Files:**

- Modify: `packages/infrastructure/src/sqlite/run-repository.ts` — already implements `RunRepositoryPort` shape; add an explicit `implements RunRepositoryPort` clause. Same for `event-repository.ts`, `failure-repository.ts`, etc.
- Modify: `packages/infrastructure/src/bash/*` — locate the bash invocation entry point. Wrap it so it exposes the type `RunBashScriptFn` already used in `packages/application/src/ports.ts`.
- Modify: `packages/infrastructure/package.json` if a new workspace import (`@ai-sdlc/application`) needs to be added so the `implements` clauses typecheck. **WARNING:** this would cross a layer boundary the other way. Verify by checking `AGENTS.md` — infrastructure may not import application. If `implements RunRepositoryPort` requires importing the port type from application, you have two options:
  1. **Preferred:** keep the ports defined in `@ai-sdlc/application` (consumer-owned interface). To get the `implements` check in infrastructure, you must move the port type to a place infrastructure already imports — i.e. `@ai-sdlc/domain`. This is a bigger move and out of scope here.
  2. **Acceptable for M3:** do NOT add the `implements` clause. Instead, add a one-line `// PORT: RunRepositoryPort (@ai-sdlc/application)` comment above each repository class, and add a typecheck-only test in `apps/api/src/__tests__/port-conformance.test.ts` that does:
     ```ts
     import type { RunRepositoryPort } from '@ai-sdlc/application';
     import { RunRepository } from '@ai-sdlc/infrastructure';
     const _check: RunRepositoryPort = new (RunRepository as new (
       ...args: never[]
     ) => RunRepository)({} as never); // typecheck only
     ```
     This proves conformance without violating the layer boundary.

Pick option 2 for this PR. The conformance test only needs to typecheck — no runtime assertion is required.

### Task 1: Add conformance tests

- [ ] **Step 1:** Create `apps/api/src/__tests__/port-conformance.test.ts`:

```ts
import { describe, it, expectTypeOf } from 'vitest';
import type {
  RunRepositoryPort,
  EventRepositoryPort,
  FailureRepositoryPort,
} from '@ai-sdlc/application';
import { RunRepository, EventRepository, FailureRepository } from '@ai-sdlc/infrastructure';

describe('infrastructure adapters implement application ports (typecheck only)', () => {
  it('RunRepository conforms to RunRepositoryPort', () => {
    expectTypeOf<RunRepository>().toMatchTypeOf<RunRepositoryPort>();
  });
  it('EventRepository conforms to EventRepositoryPort', () => {
    expectTypeOf<EventRepository>().toMatchTypeOf<EventRepositoryPort>();
  });
  it('FailureRepository conforms to FailureRepositoryPort', () => {
    expectTypeOf<FailureRepository>().toMatchTypeOf<FailureRepositoryPort>();
  });
});
```

If `expectTypeOf` is unavailable, fall back to a structural assertion via a discarded type alias as shown earlier.

- [ ] **Step 2:** Run `pnpm --filter @ai-sdlc/api test --run port-conformance`. If a port mismatch surfaces, fix the **port** (in application) — not the adapter — and re-run.

- [ ] **Step 3: Commit**

```
git add apps/api/src/__tests__/port-conformance.test.ts
git commit -m "test(m3-09): typecheck-only conformance — infrastructure repos implement application ports"
```

### Task 2: Document the Bash adapter as a port implementation

- [ ] **Step 1:** Open the file that exports `runBashScript` in `packages/infrastructure/src/bash/`. Add a JSDoc above the export:

```ts
/** Implements the `RunBashScriptFn` port from `@ai-sdlc/application/ports`. */
```

- [ ] **Step 2:** Add a similar conformance test in `apps/api/src/__tests__/port-conformance.test.ts`:

```ts
import { runBashScript } from '@ai-sdlc/infrastructure';
import type { RunBashScriptFn } from '@ai-sdlc/application';
it('runBashScript conforms to RunBashScriptFn', () => {
  const _check: RunBashScriptFn = runBashScript;
  void _check;
});
```

- [ ] **Step 3: Commit** — stage the JSDoc'd bash adapter file(s) plus the appended conformance test:

```
git add packages/infrastructure/src/bash apps/api/src/__tests__/port-conformance.test.ts
git commit -m "refactor(m3-09): document Bash adapter as RunBashScriptFn port implementation"
```

### Task 3: Final verification

- [ ] **Step 1:** `pnpm -r typecheck && pnpm -r test --run && pnpm lint && pnpm depcruise`. All M1 integration tests in `apps/api/src/__tests__/` must still pass.
- [ ] **Step 2: Stop.** All work is already committed via per-task commits. The orchestrator handles push + PR.

---

## Story M3-10 — Dependency injection / composition root

**PR scope:** Update `apps/api/src/compose.ts` so the `Container` exposes (a) an `AgentPort` resolved per-profile from `agent.profiles[name].runtime`, and (b) a `resolveProfileForPhase(phaseName)` helper backed by `agent.phaseProfiles`. In M3 the only registered runtime is the `FakeAgentPort` — real adapters land in M4.

**Files:**

- Modify: `apps/api/src/compose.ts`
- Create: `apps/api/src/agent-runtime-registry.ts`
- Create: `apps/api/src/__tests__/compose-agent.test.ts`

### Task 1: Agent runtime registry

- [ ] **Step 1: Test** — `apps/api/src/__tests__/compose-agent.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AgentProfileName } from '@ai-sdlc/application';
import { AgentRuntimeRegistry } from '../agent-runtime-registry.js';
import { FakeAgentPort } from '@ai-sdlc/application/test-doubles'; // see note below

describe('AgentRuntimeRegistry', () => {
  it('resolveProfileForPhase returns the configured profile name', () => {
    const reg = new AgentRuntimeRegistry({
      agent: {
        defaultProfile: 'opencode-frontier',
        profiles: {
          'opencode-frontier': {
            runtime: 'opencode',
            provider: 'a',
            model: 'b',
            timeoutMinutes: 60,
          },
        },
        phaseProfiles: { 'plan-design': { profile: 'opencode-frontier' } },
      },
      adapters: { opencode: new FakeAgentPort({}), pi: new FakeAgentPort({}) },
    });
    expect(reg.resolveProfileForPhase('plan-design')).toBe(AgentProfileName('opencode-frontier'));
  });
  it('resolveProfileForPhase throws on unknown phase', () => {
    const reg = new AgentRuntimeRegistry({
      agent: {
        defaultProfile: 'opencode-frontier',
        profiles: {
          'opencode-frontier': {
            runtime: 'opencode',
            provider: 'a',
            model: 'b',
            timeoutMinutes: 60,
          },
        },
        phaseProfiles: {},
      },
      adapters: { opencode: new FakeAgentPort({}), pi: new FakeAgentPort({}) },
    });
    expect(() => reg.resolveProfileForPhase('mystery')).toThrow(/unknown phase/);
  });
  it('agentPort.invoke dispatches to the adapter for the requested profile runtime', async () => {
    const opencode = new FakeAgentPort({
      [AgentProfileName('opencode-frontier')]: [
        {
          runtime: 'opencode',
          provider: 'a',
          model: 'b',
          exitCode: 0,
          durationMs: 1,
          stdoutPath: 'o',
          stderrPath: 'e',
          contractViolations: [],
          outcome: 'success',
        },
      ],
    });
    const pi = new FakeAgentPort({});
    const reg = new AgentRuntimeRegistry({
      agent: {
        defaultProfile: 'opencode-frontier',
        profiles: {
          'opencode-frontier': {
            runtime: 'opencode',
            provider: 'a',
            model: 'b',
            timeoutMinutes: 60,
          },
        },
        phaseProfiles: { 'plan-design': { profile: 'opencode-frontier' } },
      },
      adapters: { opencode, pi },
    });
    const r = await reg.agentPort.invoke({
      profile: AgentProfileName('opencode-frontier'),
      promptPath: 'p',
      expectedArtifacts: [],
      cwd: '/',
      runId: 'r',
      repoId: 'repo',
      phaseId: 'plan-design',
    });
    expect(r.outcome).toBe('success');
    expect(opencode.invocations).toHaveLength(1);
    expect(pi.invocations).toHaveLength(0);
  });
});
```

Note on `@ai-sdlc/application/test-doubles`: ensure the test-doubles barrel is exported from the application package. If `package.json` `exports` map needs updating, add:

```json
"exports": {
  ".": "./dist/index.js",
  "./test-doubles": "./dist/test-doubles/index.js"
}
```

and update the matching TypeScript build config.

- [ ] **Step 2: Implement** — `apps/api/src/agent-runtime-registry.ts`:

```ts
import { type AgentConfig } from '@ai-sdlc/shared';
import {
  type AgentPort,
  type AgentInvocationRequest,
  type AgentInvocationResult,
  type AgentRuntimeKind,
  AgentProfileName,
} from '@ai-sdlc/application';

export interface AgentRuntimeRegistryOptions {
  agent: AgentConfig;
  adapters: Record<AgentRuntimeKind, AgentPort>;
}

export class AgentRuntimeRegistry {
  readonly agentPort: AgentPort;
  constructor(private readonly opts: AgentRuntimeRegistryOptions) {
    this.agentPort = {
      invoke: (req: AgentInvocationRequest): Promise<AgentInvocationResult> => {
        const profile = opts.agent.profiles[req.profile];
        if (!profile) throw new Error(`unknown profile ${req.profile}`);
        const adapter = opts.adapters[profile.runtime as AgentRuntimeKind];
        if (!adapter) throw new Error(`no adapter registered for runtime ${profile.runtime}`);
        return adapter.invoke(req);
      },
    };
  }
  resolveProfileForPhase(phaseName: string): AgentProfileName {
    const entry = this.opts.agent.phaseProfiles[phaseName];
    if (!entry) throw new Error(`unknown phase '${phaseName}' — no entry in agent.phaseProfiles`);
    return AgentProfileName(entry.profile);
  }
}
```

- [ ] **Step 3:** Wire into `compose.ts`. Add to `Container`:

```ts
agentRuntime: AgentRuntimeRegistry;
```

…and inside `composeRoot`, after loading config:

```ts
import { loadConfig } from '@ai-sdlc/shared';
import { FakeAgentPort } from '@ai-sdlc/application/test-doubles';
import { AgentRuntimeRegistry } from './agent-runtime-registry.js';

const config = loadConfig(opts.repoRoot);
if (!config.agent) {
  throw new Error('agent section missing from .ai-orchestrator.json');
}
const agentRuntime = new AgentRuntimeRegistry({
  agent: config.agent,
  adapters: {
    // In M3 the only registered runtime is the fake. M4 swaps these for real adapters.
    opencode: new FakeAgentPort({}),
    pi: new FakeAgentPort({}),
  },
});
```

Add `agentRuntime` to the returned object.

- [ ] **Step 4:** Existing tests for `compose.ts` (`apps/api/src/__tests__/compose.test.ts` if present) must still pass. If `loadConfig` is invoked with a path lacking the agent block, decide whether to: (a) make the agent block optional and skip the registry, or (b) require it. Per M3-08 the field is optional in the schema; in `composeRoot` make `agentRuntime` `undefined` if `config.agent` is undefined, and adjust the `Container` type accordingly:

```ts
agentRuntime?: AgentRuntimeRegistry;
```

- [ ] **Step 5: Commit**

```
git add apps/api/src/compose.ts apps/api/src/__tests__/compose.test.ts
git commit -m "feat(m3-10): composition root resolves AgentPort + resolveProfileForPhase helper"
```

### Task 2: Final verification

- [ ] **Step 1:** `pnpm -r typecheck && pnpm -r test --run && pnpm lint && pnpm depcruise`.
- [ ] **Step 2: Stop.** All work is already committed via per-task commits. The orchestrator handles push + PR.

---

## Story ordering note (autonomous loop)

The milestone document lists M3-06 before M3-07, but M3-06's `AgentPort` depends on the request/result types defined in M3-07. **Execute in this order:**

1. M3-01 — core domain types
2. M3-02 — Repository registry
3. M3-03 — Job queue
4. M3-04 — Worker / WorkerLease
5. M3-05 — Application use case interfaces + non-agent ports
6. M3-07 — `AgentInvocationRequest` / `AgentInvocationResult`
7. M3-06 — `AgentPort` + `FakeAgentPort`
8. M3-08 — Agent config schema
9. M3-09 — Existing adapters wired to ports
10. M3-10 — Composition root

If the loop must follow numeric order, M3-06 should bundle the M3-07 types and the M3-07 PR becomes a no-op rename — but the order above is cleaner.

---

## Cross-cutting acceptance verification (run after the last story merges)

After M3-10 lands, run these checks once to verify the full M3 acceptance bar from `docs/milestone-stories.md`:

```
# 1. Layer boundary: no infra import in domain/application
pnpm depcruise

# 2. No concrete-runtime imports
grep -rE "from ['\"](opencode|pi|child_process)" packages/domain/src packages/application/src && echo "FAIL: concrete runtime import found" && exit 1

# 3. All tests pass
pnpm -r test --run

# 4. Typecheck clean
pnpm -r typecheck
```

All four must pass. If any fails, open a follow-up PR before declaring M3 complete.
