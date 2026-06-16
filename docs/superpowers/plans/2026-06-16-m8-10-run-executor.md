# M8-10: TypeScript Run Executor (worker-driven state machine) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `RunExecutor` and worker loop that replace Bash control flow: a Worker claims a queued Job, acquires the per-repo lease, prepares the worktree, advances through the phase registry (persisting state after every transition), and releases the lease. Resume/retry/cancel respect leases and repo locks.

**Architecture:** A `PhaseHandlerRegistry` maps `PhaseName → PhaseHandler` (handlers from M8-02…M8-09). `RunExecutor.executeRun(runId)` walks `orderedPhases(skip)` (M8-01), building a `PhaseHandlerContext` per phase, running the handler, persisting Run+Phase state, and stopping on failure. A `Worker` loop wraps it with claim → lease → worktree → execute → release. Cancellation uses an `AbortController` threaded into `AgentPort.invoke` (`AgentInvocationRequest.abortSignal`).

**Tech Stack:** TypeScript (strict, ESM), Vitest, all M3 fakes (`FakeJobQueuePort`, `FakeWorkerLeasePort`, `FakeRepositoryPort`, `FakeWorkerRegistryPort`), `@ai-sdlc/domain`.

---

## Critical context (read first)

- **ADR-0008 / Q11:** manual start enqueues a Job; the API never executes inline. Worker claims Job → acquires repo lease → prepares worktree → executes → releases. One active Run per (Repository, Issue); one active `WorkerLease` per Repository.
- **Q12:** persist after every transition — mutable status columns (source of truth for state) + append-only events. Use `RunRepositoryPort.update(uuid, patch)` (`patch.status`, `patch.currentPhase`, `patch.completedPhases`) and `PhaseRepositoryPort`.
- **Q4:** resume from failed Step by default; `--retry-phase` restarts the phase. Resume re-acquires the lease first.
- **Q23/Q24:** cancel kills the child agent (SIGTERM), resets the worktree to `startCommitSha`, releases the lease before the Run becomes terminal. `AgentInvocationRequest` already has `abortSignal?: AbortSignal`.
- **Existing pieces:** ports + fakes in `packages/application/src/ports` and `test-doubles`; use cases declared in `use-cases.ts` (`ClaimNextJobUseCase`, `AcquireRepoLeaseUseCase`, `ReleaseRepoLeaseUseCase`, `ResumeRunUseCase`, `RetryFailedPhaseUseCase`, `CancelRunUseCase`); `CancelRun` already exists at `packages/application/src/cancel-run.ts` — extend/compose, don't duplicate. `WorkerLeasePort.acquire/heartbeat/release/reclaimExpired/current` exists with fake. `JobQueuePort.claimNext/markRunning/markSucceeded/markFailed` exists with fake.
- Handlers (M8-02…M8-09) implement `PhaseHandler` (M8-02). Their context needs ports + `resolveProfile` + `startCommitSha` + `expectedBranch` + `promptsRoot` + `idFactory` (M8-03 extended it).
- There is **no `apps/worker`**; the worker loop lives in `apps/api` (the composition root is `apps/api/src/compose.ts`). Add the executor in `packages/application` and the loop entrypoint in `apps/api`.

## File structure

- Create: `packages/application/src/executor/phase-handler-registry.ts`
- Create: `packages/application/src/executor/run-executor.ts`
- Create: `packages/application/src/executor/worker-loop.ts`
- Create tests under `packages/application/src/executor/__tests__/`
- Modify: `packages/application/src/index.ts`, `apps/api/src/compose.ts` (wire executor + worker entrypoint)

---

### Task 1: PhaseHandlerRegistry

**Files:**
- Create: `packages/application/src/executor/phase-handler-registry.ts`
- Test: `packages/application/src/executor/__tests__/phase-handler-registry.test.ts`

- [ ] **Step 1: Write the failing test:**

```ts
import { describe, it, expect } from 'vitest';
import { PhaseHandlerRegistry } from '../phase-handler-registry.js';
import type { PhaseHandler } from '../../phases/handler.js';
import type { PhaseName } from '@ai-sdlc/domain';

const stub = (name: string): PhaseHandler => ({ phase: name as PhaseName, run: async () => ({ outcome: 'passed' }) });

describe('PhaseHandlerRegistry', () => {
  it('returns the registered handler for a phase', () => {
    const reg = new PhaseHandlerRegistry([stub('plan-design')]);
    expect(reg.get('plan-design' as PhaseName).phase).toBe('plan-design');
  });
  it('throws for an unregistered phase', () => {
    const reg = new PhaseHandlerRegistry([]);
    expect(() => reg.get('plan-design' as PhaseName)).toThrow();
  });
});
```

- [ ] **Step 2: Run → FAIL.** `pnpm exec vitest run packages/application/src/executor/__tests__/phase-handler-registry.test.ts`

- [ ] **Step 3: Implement:**

```ts
import type { PhaseName } from '@ai-sdlc/domain';
import type { PhaseHandler } from '../phases/handler.js';

export class PhaseHandlerRegistry {
  private readonly byName = new Map<string, PhaseHandler>();
  constructor(handlers: PhaseHandler[]) {
    for (const h of handlers) this.byName.set(h.phase as unknown as string, h);
  }
  get(phase: PhaseName): PhaseHandler {
    const h = this.byName.get(phase as unknown as string);
    if (!h) throw new Error(`no handler registered for phase '${phase}'`);
    return h;
  }
  has(phase: PhaseName): boolean {
    return this.byName.has(phase as unknown as string);
  }
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(application): PhaseHandlerRegistry"`

---

### Task 2: `RunExecutor.executeRun` — advance phases, persist, skip, input-gate

**Files:**
- Create: `packages/application/src/executor/run-executor.ts`
- Test: `packages/application/src/executor/__tests__/run-executor.test.ts`

- [ ] **Step 1: Write the failing test** (happy path across a small phase set, asserting persistence after each transition and stop-on-failure):

```ts
import { describe, it, expect, vi } from 'vitest';
import { RunExecutor } from '../run-executor.js';
import { PhaseHandlerRegistry } from '../phase-handler-registry.js';
import type { PhaseHandler } from '../../phases/handler.js';
import type { PhaseName } from '@ai-sdlc/domain';

function passing(name: string): PhaseHandler {
  return { phase: name as PhaseName, run: vi.fn(async () => ({ outcome: 'passed' as const })) };
}
function failing(name: string): PhaseHandler {
  return { phase: name as PhaseName, run: async () => ({ outcome: 'failed' as const, failure: { runUuid: 'u', phase: name, kind: 'unknown' as const, message: 'x', canRetry: true, suggestedAction: '', artifacts: [], detectedAt: new Date() } }) };
}

describe('RunExecutor.executeRun', () => {
  it('advances phases in order and persists status after each', async () => {
    const updates: Array<{ status?: string; currentPhase?: string | null }> = [];
    const runRepo = { update: (_u: string, p: { status?: string; currentPhase?: string | null }) => updates.push(p), findByUuid: () => ({ uuid: 'u' }) } as never;
    const executor = makeExecutor({
      runRepo,
      handlers: new PhaseHandlerRegistry([passing('read_issue'), passing('plan-design')]),
      phaseOrder: ['read_issue', 'plan-design'],
    });
    const result = await executor.executeRun('u');
    expect(result.status).toBe('passed');
    expect(updates.filter((u) => u.currentPhase === 'plan-design')).not.toHaveLength(0);
  });

  it('stops and marks failed when a phase fails', async () => {
    const executor = makeExecutor({
      handlers: new PhaseHandlerRegistry([passing('read_issue'), failing('plan-design')]),
      phaseOrder: ['read_issue', 'plan-design'],
    });
    const result = await executor.executeRun('u');
    expect(result.status).toBe('failed');
    expect(result.failedPhase).toBe('plan-design');
  });
});
```

> Provide a small `makeExecutor(overrides)` helper in the test that builds a `RunExecutor` with fakes (`FakeArtifactStore`, fake event bus, a stub run repo, a stub phase repo, and an injected `phaseOrder` + `buildContext`). Keep the executor's dependencies injectable so tests don't need the full container.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `run-executor.ts`** (core loop; trimmed to essentials):

```ts
import type { PhaseName, Failure } from '@ai-sdlc/domain';
import { orderedPhases, getPhaseDefinition, assertInputsAvailable, MissingRequiredInputError } from '../phases/phase-definitions.js';
import type { PhaseHandlerRegistry } from './phase-handler-registry.js';
import type { PhaseHandlerContext, PhaseResult } from '../phases/handler.js';

export interface RunExecutorDeps {
  handlers: PhaseHandlerRegistry;
  skip: PhaseName[];
  /** Builds the per-phase context (ports, resolveProfile, startCommitSha, etc). */
  buildContext: (phase: PhaseName) => Promise<PhaseHandlerContext>;
  /** Persists run-level state after every transition. */
  persistRun: (patch: { status?: string; currentPhase?: string | null; completedPhases?: string[] }) => void;
  /** Persists phase-level state. */
  persistPhase: (phase: PhaseName, status: 'running' | 'passed' | 'failed' | 'skipped') => void;
  /** Returns artifacts currently present for the run (for input gating). */
  presentArtifacts: () => Promise<string[]>;
}

export interface RunExecutionResult {
  status: 'passed' | 'failed' | 'blocked';
  failedPhase?: PhaseName;
  failure?: Failure;
}

export class RunExecutor {
  constructor(private readonly deps: RunExecutorDeps) {}

  async executeRun(_runUuid: string): Promise<RunExecutionResult> {
    const phases = orderedPhases(this.deps.skip);
    const completed: string[] = [];

    for (const def of phases) {
      const phase = def.name;

      // Pre-flight input gating (Q31/Q32).
      try {
        assertInputsAvailable(def, await this.deps.presentArtifacts());
      } catch (e) {
        if (e instanceof MissingRequiredInputError) {
          this.deps.persistPhase(phase, 'failed');
          this.deps.persistRun({ status: 'failed', currentPhase: phase as unknown as string });
          return { status: 'failed', failedPhase: phase };
        }
        throw e;
      }

      this.deps.persistRun({ currentPhase: phase as unknown as string });
      this.deps.persistPhase(phase, 'running');

      const ctx = await this.deps.buildContext(phase);
      const result: PhaseResult = await this.deps.handlers.get(phase).run(ctx);

      if (result.outcome === 'skipped') {
        this.deps.persistPhase(phase, 'skipped');
        continue;
      }
      if (result.outcome === 'passed') {
        this.deps.persistPhase(phase, 'passed');
        completed.push(phase as unknown as string);
        this.deps.persistRun({ completedPhases: [...completed] });
        continue;
      }
      // failed or blocked → stop (Q1: cannot pass with a failed required phase)
      this.deps.persistPhase(phase, 'failed');
      this.deps.persistRun({
        status: result.outcome === 'blocked' ? 'blocked' : 'failed',
        currentPhase: phase as unknown as string,
      });
      return {
        status: result.outcome === 'blocked' ? 'blocked' : 'failed',
        failedPhase: phase,
        ...(result.failure ? { failure: result.failure } : {}),
      };
    }

    this.deps.persistRun({ status: 'passed' });
    return { status: 'passed' };
  }
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(application): RunExecutor phase loop with persistence + input gating"`

---

### Task 3: Worker loop — claim, lease, serialize, release

**Files:**
- Create: `packages/application/src/executor/worker-loop.ts`
- Test: `packages/application/src/executor/__tests__/worker-loop.test.ts`

- [ ] **Step 1: Write failing tests** using `FakeJobQueuePort`, `FakeWorkerLeasePort`, `FakeRepositoryPort`, `FakeWorkerRegistryPort`:
  - two queued Jobs for the **same** repo are processed serially (second waits for the lease);
  - Jobs for **different** repos run concurrently;
  - the lease is released in a `finally` even when `executeRun` throws.

(Model the concurrency assertions on `packages/application/src/__tests__/worker-concurrency.test.ts`.)

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `worker-loop.ts`:**

```ts
import type { WorkerId, RepositoryId } from '@ai-sdlc/domain';
import type { JobQueuePort } from '../ports/job-queue-port.js';
import type { WorkerLeasePort } from '../ports/worker-lease-port.js';
import type { RunExecutor } from './run-executor.js';

export interface WorkerLoopDeps {
  workerId: WorkerId;
  jobs: JobQueuePort;
  leases: WorkerLeasePort;
  executorFor: (job: { runId: string; repoId: RepositoryId }) => RunExecutor;
  prepareWorktree: (repoId: RepositoryId, runId: string) => Promise<void>;
  now: () => Date;
}

export class WorkerLoop {
  constructor(private readonly deps: WorkerLoopDeps) {}

  /** Processes a single claimed job end-to-end. Returns false when no job was available. */
  async tick(): Promise<boolean> {
    const claimed = this.deps.jobs.claimNext({ workerId: this.deps.workerId });
    if (!claimed) return false;

    let acquired = false;
    try {
      this.deps.leases.acquire({ repoId: claimed.repoId, workerId: this.deps.workerId, runId: claimed.runId });
      acquired = true;
      this.deps.jobs.markRunning(claimed.id);
      await this.deps.prepareWorktree(claimed.repoId, claimed.runId);

      const result = await this.deps.executorFor({ runId: claimed.runId, repoId: claimed.repoId }).executeRun(claimed.runId);

      if (result.status === 'passed') this.deps.jobs.markSucceeded(claimed.id);
      else this.deps.jobs.markFailed(claimed.id);
    } catch (e) {
      this.deps.jobs.markFailed(claimed.id);
      throw e;
    } finally {
      if (acquired) this.deps.leases.release({ repoId: claimed.repoId, workerId: this.deps.workerId });
    }
    return true;
  }
}
```

> Verify the exact `JobQueuePort`/`WorkerLeasePort` method signatures (`claimNext` return shape, `acquire`/`release` arg shapes) against `packages/application/src/ports/*` and adjust. The fakes are the contract.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(application): worker loop with repo-lease serialization"`

---

### Task 4: Cancellation — SIGTERM, worktree reset, lease release

**Files:**
- Modify: `packages/application/src/cancel-run.ts` (compose with executor) or add `executor/cancel.ts`
- Test: `packages/application/src/executor/__tests__/cancel.test.ts`

- [ ] **Step 1: Write failing test:** a running executor with an injected `AbortController`; calling cancel aborts the signal passed to `AgentPort.invoke`, calls `git.resetHard(cwd, startCommitSha)`, sets run status `cancelled`, and releases the lease **before** the terminal transition. Use `FakeGitPort` (assert `resetHard` called) and `FakeWorkerLeasePort` (assert `release` called before status set to cancelled).

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** by threading an `AbortController` per active invocation (set `request.abortSignal = controller.signal`), storing the active `{ cwd, startCommitSha, controller }`, and a `cancel()` that: aborts the controller → awaits child cleanup → `git.resetHard(cwd, startCommitSha)` → `leases.release(...)` → `runRepo.update(uuid, { status: 'cancelled', completedAt })`. Reuse the existing `CancelRun` (`packages/application/src/cancel-run.ts`) — extend it to also reset the worktree + release the lease if it doesn't already.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(application): cancellation resets worktree + releases lease"`

---

### Task 5: Resume + retry-phase

**Files:**
- Create: `packages/application/src/executor/resume.ts` (or extend RunExecutor)
- Test: `packages/application/src/executor/__tests__/resume.test.ts`

- [ ] **Step 1: Write failing tests:**
  - **Resume:** a run failed at phase X resumes by re-acquiring the lease and starting at X (phases before X are not re-run). Default resume starts at the first failed Step within `implement` (delegated to M8-04's resume-skip).
  - **Retry-phase:** `executeRun(uuid, { retryPhase: X })` re-runs X from the start.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** by adding an optional `{ fromPhase?, retryPhase? }` to `executeRun` that seeds the starting index from `orderedPhases` and re-acquires the lease before any work (Q4). Implement the `ResumeRunUseCase`/`RetryFailedPhaseUseCase` interfaces from `use-cases.ts` as thin wrappers over this.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(application): resume-from-phase + retry-phase"`

---

### Task 6: Dead-worker lease reclamation

**Files:**
- Test: `packages/application/src/executor/__tests__/lease-reclaim.test.ts`

- [ ] **Step 1: Write failing test:** simulate a worker that acquired a lease then "died" (stale heartbeat past `expiresAt`, worker marked unhealthy). `WorkerLeasePort.reclaimExpired(now)` reclaims it per the M3-04 safety checks; a second worker can then claim and re-run the job. Assert the lease is reclaimable only when the safety conditions hold (not while the owner is alive).

- [ ] **Step 2: Run → adjust** — `reclaimExpired` already exists (M3-04). This task verifies the executor/worker integrate it (e.g. the worker periodically calls `reclaimExpired` before claiming). Add that call to the loop if absent.

- [ ] **Step 3: Implement** the periodic `reclaimExpired` call in the worker loop bootstrap.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(application): worker reclaims expired leases before claiming"`

---

### Task 7: Wire into compose root + end-to-end happy path

**Files:**
- Modify: `apps/api/src/compose.ts` (build `PhaseHandlerRegistry`, `RunExecutor`, `WorkerLoop`)
- Test: `packages/application/src/executor/__tests__/end-to-end.test.ts`

- [ ] **Step 1: Write the end-to-end test** with **all in-memory fakes** + stub handlers for every canonical phase, asserting a full issue run completes `passed` without any Bash. Assert state was persisted after each transition (spy on `persistRun`).

- [ ] **Step 2: Run → FAIL/PASS** as you implement the wiring.

- [ ] **Step 3: Wire `compose.ts`:** construct the registry from the real handlers (M8-02…M8-09), build `buildContext` (resolve profile via the existing `resolveProfileForPhase`/`phaseProfiles` wiring already in `compose.ts`, capture `startCommitSha` via `GitPort.headCommitSha`, set `expectedBranch`), and expose the `WorkerLoop`. Keep the existing Bash path available behind a flag until M8-11 retires it.

- [ ] **Step 4: Full sweep:** `pnpm -r typecheck && pnpm lint && pnpm depcruise && pnpm test` → all PASS.

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: wire RunExecutor + WorkerLoop into composition root"`

---

## Self-review checklist

- [ ] Acceptance → tests: happy path Bash-free (Task 2, Task 7), lease serialize vs concurrency (Task 3), persist-after-transition (Task 2/7), resume + retry-phase (Task 5), cancel resets worktree + releases lease (Task 4), dead-worker reclaim (Task 6), skip recorded as skipped (Task 2).
- [ ] Lease released in `finally` on all paths including throws (Task 3).
- [ ] No `child_process`/SQLite/`gh` in the executor — all via ports (depcruise).
- [ ] Reuses existing `CancelRun`, `reclaimExpired`, fakes, and the compose-root profile resolution.
- [ ] Names consistent: `RunExecutor`, `PhaseHandlerRegistry`, `WorkerLoop`, `executeRun`.

## Definition of done

Merged with green CI; happy-path issue run completes through the registry with zero Bash control flow; lease/resume/retry/cancel/reclaim proven against fakes; state persisted after every transition.
