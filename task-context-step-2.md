# Task Context: Task 2

Title: Implement OrphanedRunsSweeper
## Workspace & Scope Constraints

## WORKSPACE CONSTRAINTS

Your working directory is a dedicated git worktree with the repository's complete history. Run all commands from it. Do NOT cd to or read paths outside this directory — external-directory access is automatically rejected. git log, git diff, etc. work here directly.

.ai-orchestrator.local.json, if one exists, lives only in the main checkout and is intentionally not copied into your worktree — it is operator-machine-specific and not part of your task. Do not search for it or read it outside this directory. Reason about configuration using only .ai-orchestrator.json in your own working directory; treat it as the effective config for your task.

Working Directory: /home/gary/.openclaw/workspace/automation/.ai-worktrees/issue-693
Repository: opsclawd/automation
Branch: ai/issue-693
Start Commit: eb7e4968fceba83f6c4f30687a035a1a859232f0

## Task Requirements

**Files:**

- Create: `packages/application/src/orphaned-runs-sweeper.ts`
- Test: `packages/application/src/__tests__/orphaned-runs-sweeper.test.ts`

- [ ] **Step 2.1: Write failing unit tests for the new use case**

Create `packages/application/src/__tests__/orphaned-runs-sweeper.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createRun,
  RepositoryId,
  WorkerId,
  WorkerLeaseConflictError,
  failRun,
} from '@ai-sdlc/domain';
import { OrphanedRunsSweeper } from '../orphaned-runs-sweeper.js';
import { FakeRunRepository } from '../test-doubles/fake-run-repository.js';
import { FakeJobQueuePort } from '../test-doubles/fake-job-queue-port.js';
import { FakeWorkerLeasePort } from '../test-doubles/fake-worker-lease-port.js';
import { FakeWorkerRegistryPort } from '../test-doubles/fake-worker-lease-port.js';
import { FakeRepositoryPort } from '../test-doubles/fake-repository-port.js';
import { FakeEventBus } from '../test-doubles/fake-event-bus.js';

const fixedNow = new Date('2026-07-10T00:00:00Z');
const workerId = WorkerId('serve-1');
const repoId = RepositoryId('owner/repo');

function makeFailedRun(uuid: string, completedPhases: string[] = []) {
  const run = createRun({
    uuid,
    displayId: `issue-${uuid}-20260710-000000`,
    repoId,
    issueNumber: 1,
    startedAt: new Date('2026-07-09T00:00:00Z'),
  });
  return failRun(
    {
      ...run,
      completedPhases,
    },
    'orphaned: process 99999 no longer running',
    fixedNow,
  );
}

describe('OrphanedRunsSweeper', () => {
  let runRepo: FakeRunRepository;
  let queue: FakeJobQueuePort;
  let leases: FakeWorkerLeasePort;
  let registry: FakeWorkerRegistryPort;
  let repos: FakeRepositoryPort;
  let eventBus: FakeEventBus;

  beforeEach(() => {
    runRepo = new FakeRunRepository();
    registry = new FakeWorkerRegistryPort();
    repos = new FakeRepositoryPort([
      {
        id: repoId,
        fullName: 'owner/repo',
        localBasePath: '/tmp/owner-repo',
        defaultBranch: 'main',
        enabled: true,
      } as never,
    ]);
    queue = new FakeJobQueuePort(repos);
    leases = new FakeWorkerLeasePort(registry);
    eventBus = new FakeEventBus();
  });

  it('enqueues a job and transitions failed to running for each orphaned run', async () => {
    const failed = makeFailedRun('o1');
    runRepo.addRun(failed);

    const sweeper = new OrphanedRunsSweeper({
      runRepository: runRepo,
      leases,
      queue,
      eventBus,
      now: () => fixedNow,
      logger: { error: () => {} },
    });

    const result = await sweeper.execute([
      { uuid: 'o1', run: failed, previousPid: 99999 },
    ]);

    expect(result.enqueued).toBe(1);
    expect(result.skippedLeaseConflict).toBe(0);
    expect(result.enqueueErrors).toEqual([]);
    expect(queue.listForRun('o1' as never)).toHaveLength(1);
    expect(runRepo.findByUuid('o1')?.status).toBe('running');
    // Lease released so a worker can re-acquire it
    expect(leases.current(repoId)).toBeUndefined();
  });

  it('skips runs whose lease is held by another worker', async () => {
    const failed = makeFailedRun('o2');
    runRepo.addRun(failed);
    leases.acquire({
      repoId,
      workerId: WorkerId('other-worker'),
      runId: 'o2' as never,
      now: fixedNow,
      ttlMs: 60_000,
    });

    const sweeper = new OrphanedRunsSweeper({
      runRepository: runRepo,
      leases,
      queue,
      eventBus,
      now: () => fixedNow,
      logger: { error: () => {} },
    });

    const result = await sweeper.execute([
      { uuid: 'o2', run: failed, previousPid: 99999 },
    ]);

    expect(result.enqueued).toBe(0);
    expect(result.skippedLeaseConflict).toBe(1);
    expect(result.enqueueErrors).toEqual([]);
    expect(runRepo.findByUuid('o2')?.status).toBe('failed');
    expect(queue.listForRun('o2' as never)).toHaveLength(0);
  });

  it('skips runs whose lease acquire throws a non-conflict error', async () => {
    const failed = makeFailedRun('o3');
    runRepo.addRun(failed);
    vi.spyOn(leases, 'acquire').mockImplementationOnce(() => {
      throw new Error('lease DB unavailable');
    });

    const sweeper = new OrphanedRunsSweeper({
      runRepository: runRepo,
      leases,
      queue,
      eventBus,
      now: () => fixedNow,
      logger: { error: () => {} },
    });

    const result = await sweeper.execute([
      { uuid: 'o3', run: failed, previousPid: 99999 },
    ]);

    expect(result.enqueued).toBe(0);
    expect(result.skippedLeaseConflict).toBe(0);
    expect(result.enqueueErrors).toHaveLength(1);
    expect(result.enqueueErrors[0]!.error).toBe('lease DB unavailable');
    expect(runRepo.findByUuid('o3')?.status).toBe('failed');
  });

  it('does not enqueue if a run already has an active job', async () => {
    const failed = makeFailedRun('o4');
    runRepo.addRun(failed);
    // Pre-existing active job for the same runId (simulating a re-enqueue attempt)
    vi.spyOn(queue, 'listActive').mockReturnValueOnce([
      {
        id: 'existing-job' as never,
        runId: 'o4' as never,
        repoId,
        issueNumber: 1,
        priority: 10,
        status: 'queued',
        createdAt: fixedNow,
      } as never,
    ]);

    const sweeper = new OrphanedRunsSweeper({
      runRepository: runRepo,
      leases,
      queue,
      eventBus,
      now: () => fixedNow,
      logger: { error: () => {} },
    });

    const result = await sweeper.execute([
      { uuid: 'o4', run: failed, previousPid: 99999 },
    ]);

    expect(result.enqueued).toBe(0);
    expect(result.skippedAlreadyQueued).toBe(1);
    expect(runRepo.findByUuid('o4')?.status).toBe('failed');
  });

  it('rolls back status to failed when enqueue throws after the status flip', async () => {
    const failed = makeFailedRun('o5');
    runRepo.addRun(failed);
    vi.spyOn(queue, 'enqueue').mockImplementationOnce(() => {
      throw new Error('enqueue DB write failed');
    });

    const sweeper = new OrphanedRunsSweeper({
      runRepository: runRepo,
      leases,
      queue,
      eventBus,
      now: () => fixedNow,
      logger: { error: () => {} },
    });

    const result = await sweeper.execute([
      { uuid: 'o5', run: failed, previousPid: 99999 },
    ]);

    expect(result.enqueued).toBe(0);
    expect(result.enqueueErrors).toHaveLength(1);
    expect(result.enqueueErrors[0]!.error).toBe('enqueue DB write failed');
    expect(runRepo.findByUuid('o5')?.status).toBe('failed');
  });
});
```

- [ ] **Step 2.2: Run the new tests to confirm they fail**

Run: `pnpm --filter @ai-sdlc/application test -- orphaned-runs-sweeper.test.ts`
Expected: FAIL — `OrphanedRunsSweeper` module does not exist.

- [ ] **Step 2.3: Implement OrphanedRunsSweeper**

Create `packages/application/src/orphaned-runs-sweeper.ts`:

```ts
import {
  createJob,
  resumeRun,
  WorkerLeaseConflictError,
  type IssueNumber,
  type JobId,
  type RunId,
  type Run,
  type WorkerId,
} from '@ai-sdlc/domain';
import type { RunRecord, RunRepositoryPort } from './ports.js';
import type { JobQueuePort, WorkerLeasePort } from './ports/index.js';
import type { EventBusPort } from './ports/event-bus-port.js';
import type { LoggerPort } from './ports/logger-port.js';
import type { SweepOrphanedRunEntry } from './sweep-orphaned-runs.js';

const ORPHAN_RECOVERY_JOB_PRIORITY = 10;
const LEASE_TTL_MS = 30_000;

export interface OrphanedRunsSweeperDeps {
  runRepository: RunRepositoryPort;
  leases: WorkerLeasePort;
  queue: JobQueuePort;
  eventBus: EventBusPort;
  now: () => Date;
  logger: LoggerPort;
}

export interface OrphanedRunsSweeperResult {
  scanned: number;
  enqueued: number;
  skippedLeaseConflict: number;
  skippedAlreadyQueued: number;
  enqueueErrors: Array<{ runId: string; error: string }>;
}

export class OrphanedRunsSweeper {
  constructor(private readonly deps: OrphanedRunsSweeperDeps) {}

  async execute(entries: SweepOrphanedRunEntry[]): Promise<OrphanedRunsSweeperResult> {
    const result: OrphanedRunsSweeperResult = {
      scanned: entries.length,
      enqueued: 0,
      skippedLeaseConflict: 0,
      skippedAlreadyQueued: 0,
      enqueueErrors: [],
    };

    for (const entry of entries) {
      const run = entry.run;

      // Lease guard: a live worker holds the lease for this repo. Skip —
      // the drain loop will pick up the run when the worker eventually
      // finishes or the lease expires.
      if (this.deps.leases.checkActiveLease(run.repoId, this.deps.now())) {
        result.skippedLeaseConflict++;
        this.deps.logger.error(
          `OrphanedRunsSweeper: Active lease for repo ${run.repoId}, skipping ${run.uuid}`,
        );
        continue;
      }

      // Idempotency: another sweeper tick (or the same tick in another
      // process) already enqueued a job for this run.
      const activeForRun = this.deps.queue.listForRun(run.uuid as RunId);
      if (activeForRun.length > 0) {
        result.skippedAlreadyQueued++;
        continue;
      }

      let leaseAcquired = false;
      try {
        this.deps.leases.acquire({
          repoId: run.repoId,
          workerId: ('orphan-sweeper' as unknown) as WorkerId,
          runId: run.uuid as RunId,
          now: this.deps.now(),
          ttlMs: LEASE_TTL_MS,
        });
        leaseAcquired = true;
      } catch (err) {
        if (err instanceof WorkerLeaseConflictError) {
          result.skippedLeaseConflict++;
          this.deps.logger.error(
            `OrphanedRunsSweeper: Lease conflict for run ${run.uuid}, skipping: ${err.message}`,
          );
        } else {
          result.enqueueErrors.push({
            runId: run.uuid,
            error: err instanceof Error ? err.message : String(err),
          });
          this.deps.logger.error(
            `OrphanedRunsSweeper: Failed to acquire lease for run ${run.uuid}:`,
            err,
          );
        }
        continue;
      }

      const expectedStatus = run.status; // 'failed' from SweepOrphanedRuns
      try {
        // Atomically transition failed -> running. resumeRun clears
        // completedAt / failureReason and preserves completedPhases +
        // skippedPhases so the worker picks up at the right point.
        const next = resumeRun(run as Run);
        const updated = this.deps.runRepository.atomicUpdateByUuid(
          run.uuid,
          {
            status: next.status,
            completedAt: null,
            failureReason: null,
            pid: null,
          },
          expectedStatus,
        );
        if (!updated) {
          this.deps.logger.error(
            `OrphanedRunsSweeper: run ${run.uuid} status changed concurrently (expected ${expectedStatus}), skipping`,
          );
          continue;
        }

        try {
          this.deps.eventBus.publish(run.uuid, {
            runId: run.uuid,
            level: 'info',
            type: 'orchestrator.run.recovered_from_orphan',
            message: `Run recovered from orphaned pid ${entry.previousPid}`,
            timestamp: this.deps.now().toISOString(),
            metadata: { previousPid: entry.previousPid },
          });

          const job = createJob({
            id: `orphan-${run.uuid}-${this.deps.now().getTime()}` as JobId,
            runId: run.uuid as RunId,
            repoId: run.repoId,
            issueNumber: run.issueNumber as IssueNumber,
            priority: ORPHAN_RECOVERY_JOB_PRIORITY,
            createdAt: this.deps.now(),
          });
          this.deps.queue.enqueue({ job });
          result.enqueued++;
        } catch (err) {
          this.deps.logger.error(
            `OrphanedRunsSweeper: Enqueue failed for run ${run.uuid}, rolling back to failed:`,
            err,
          );
          const rolled = this.deps.runRepository.atomicUpdateByUuid(
            run.uuid,
            { status: 'failed', completedAt: null, failureReason: null, pid: null },
            'running',
          );
          if (!rolled) {
            this.deps.logger.error(
              `OrphanedRunsSweeper: Critical - rollback atomicUpdateByUuid failed for run ${run.uuid}`,
            );
          }
          throw err;
        }
      } catch (err) {
        result.enqueueErrors.push({
          runId: run.uuid,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (leaseAcquired) {
          try {
            this.deps.leases.release(run.repoId, ('orphan-sweeper' as unknown) as WorkerId);
          } catch (relErr) {
            this.deps.logger.error(
              `OrphanedRunsSweeper: Failed to release lease on completion for ${run.uuid}:`,
              relErr,
            );
          }
        }
      }
    }

    return result;
  }
}
```

- [ ] **Step 2.4: Re-run tests to confirm they pass**

Run: `pnpm --filter @ai-sdlc/application test -- orphaned-runs-sweeper.test.ts`
Expected: PASS — all 5 unit tests pass.

- [ ] **Step 2.5: Verify port contract usage**

Run: `pnpm --filter @ai-sdlc/application typecheck`
Run: `pnpm depcruise`
Expected: PASS. The new file only imports from `@ai-sdlc/domain` (allowed) and `./ports*.js` and `./sweep-orphaned-runs.js` (same package, allowed).

- [ ] **Step 2.6: Commit**

```bash
git add packages/application/src/orphaned-runs-sweeper.ts packages/application/src/__tests__/orphaned-runs-sweeper.test.ts
git commit -m "feat(application): OrphanedRunsSweeper enqueues resume jobs for swept orphan runs"
```

---

