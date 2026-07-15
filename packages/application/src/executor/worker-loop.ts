import type { WorkerId, JobId, RepositoryId, RunId, Run, Job } from '@ai-sdlc/domain';
import type {
  WorkerRegistryPort,
  JobQueuePort,
  WorkerLeasePort,
  RepositoryPort,
} from '../ports.js';
import { WorkerLeaseConflictError } from '@ai-sdlc/domain';

export interface WorkerLoopDeps {
  registry: WorkerRegistryPort;
  queue: JobQueuePort;
  leases: WorkerLeasePort;
  repos: RepositoryPort;
  repoId: RepositoryId;
  executeRun: (input: {
    run: Run;
    workerId: WorkerId;
    cwd: string;
    signal: AbortSignal;
  }) => Promise<{ ok: boolean }>;
  prepareWorktree: (input: {
    repoId: RepositoryId;
    runId: RunId;
    signal: AbortSignal;
  }) => Promise<{ cwd: string }>;
  resetWorktree: (repoId: RepositoryId) => void;
  isWorkerAlive: (workerId: WorkerId) => boolean;
  recoverableRunIds: ReadonlySet<RunId>;
  now: () => Date;
  ttlMs: number;
  executeRunGraceMs?: number;
  findRun: (runId: RunId) => Run | undefined;
  onLeaseReclaimed?: (info: {
    repoId: RepositoryId;
    previousWorkerId: WorkerId;
    previousRunId: RunId;
    reclaimedByWorkerId: WorkerId;
    reason: string;
  }) => void;
  onProgress?: () => void;
  outerSignal?: AbortSignal;
  heartbeatIntervalMs?: number;
}

function isRunnable(status: string): boolean {
  return status === 'idle' || status === 'busy';
}

/**
 * Runs a single already-claimed job to completion: acquires the run lease,
 * maintains a heartbeat, prepares the worktree, invokes `executeRun`, and
 * settles the job (succeeded/failed/cancelled/released). Callers that claim
 * jobs themselves (e.g. a fair cross-repository scheduler) can invoke this
 * directly instead of going through `workerLoop`'s own claim-and-drain loop.
 *
 * Returns `'lease_conflict'` if the run's lease was held by another worker
 * (the job claim has already been released and added to `skippedJobIds`),
 * or `'settled'` once the job has reached a terminal state.
 */
export async function runClaimedJob(
  workerId: WorkerId,
  job: Job,
  deps: WorkerLoopDeps,
  skippedJobIds?: Set<JobId>,
): Promise<'settled' | 'lease_conflict'> {
  const { registry, queue, leases } = deps;

  let started = false;
  let acquired = false;
  let acquiredLease;

  try {
    registry.markBusy(workerId, deps.repoId);

    acquiredLease = leases.acquire({
      repoId: job.repoId,
      workerId,
      runId: job.runId,
      now: deps.now(),
      ttlMs: deps.ttlMs,
    });
    acquired = true;

    const abortController = new AbortController();

    const heartbeatInterval = setInterval(
      () => {
        try {
          const now = deps.now();
          leases.heartbeat({
            repoId: job.repoId,
            workerId,
            runId: job.runId,
            now,
            newExpiresAt: new Date(now.getTime() + deps.ttlMs),
            leaseToken: acquiredLease!.leaseToken,
          });
          deps.onProgress?.();
        } catch {
          clearInterval(heartbeatInterval);
          abortController.abort();
        }
      },
      Math.max(Math.floor(deps.ttlMs / 2), deps.heartbeatIntervalMs ?? 1_000),
    );

    try {
      queue.markRunning(job.id, deps.now());
      started = true;

      const worktree = await Promise.race([
        deps.prepareWorktree({
          repoId: job.repoId,
          runId: job.runId,
          signal: abortController.signal,
        }),
        new Promise<never>((_, reject) => {
          if (abortController.signal.aborted) {
            reject(new Error('heartbeat failed during worktree preparation'));
            return;
          }
          abortController.signal.addEventListener(
            'abort',
            () => reject(new Error('heartbeat failed during worktree preparation')),
            { once: true },
          );
        }),
      ]);

      const run = deps.findRun(job.runId);
      if (!run) {
        throw new Error(`run ${job.runId} not found for job ${job.id}`);
      }

      const executeRunPromise = deps.executeRun({
        run,
        workerId,
        cwd: worktree.cwd,
        signal: abortController.signal,
      });

      const result = await new Promise<{ ok: boolean }>((resolve, reject) => {
        let graceTimer: ReturnType<typeof setTimeout> | undefined;

        const onAbort = () => {
          graceTimer = setTimeout(
            () => reject(new Error('heartbeat failed during job execution')),
            deps.executeRunGraceMs ?? 10_000,
          );
          void executeRunPromise.then(
            () => {
              clearTimeout(graceTimer);
              reject(new Error('heartbeat failed during job execution'));
            },
            (err) => {
              clearTimeout(graceTimer);
              reject(new Error(`heartbeat failed during job execution: ${(err as Error).message}`));
            },
          );
        };

        if (abortController.signal.aborted) {
          onAbort();
          return;
        }

        abortController.signal.addEventListener('abort', onAbort, { once: true });

        void executeRunPromise.then(
          (r) => {
            if (!abortController.signal.aborted) {
              abortController.signal.removeEventListener('abort', onAbort);
              resolve(r);
            }
          },
          (err) => {
            if (!abortController.signal.aborted) {
              abortController.signal.removeEventListener('abort', onAbort);
              reject(err as Error);
            }
          },
        );
      });

      if (result.ok) {
        queue.markSucceeded(job.id, deps.now());
      } else {
        queue.markFailed(job.id, deps.now());
      }
      return 'settled';
    } finally {
      clearInterval(heartbeatInterval);
    }
  } catch (err) {
    if (err instanceof WorkerLeaseConflictError) {
      queue.releaseClaim(job.id);
      skippedJobIds?.add(job.id);
      return 'lease_conflict';
    }
    if (started) {
      if (deps.outerSignal?.aborted) {
        try {
          queue.markCancelled(job.id, deps.now());
        } catch {
          /* already terminal */
        }
      } else {
        queue.markFailed(job.id, deps.now());
      }
    } else {
      queue.releaseClaim(job.id);
    }
    return 'settled';
  } finally {
    if (acquired && acquiredLease) {
      leases.release({
        repoId: job.repoId,
        workerId,
        runId: job.runId,
        leaseToken: acquiredLease.leaseToken,
      });
    }
    const afterRelease = registry.findById(workerId, deps.repoId);
    if (afterRelease && isRunnable(afterRelease.status)) {
      registry.markIdle(workerId, deps.repoId);
    }
  }
}

export async function workerLoop(workerId: WorkerId, deps: WorkerLoopDeps): Promise<void> {
  const { registry, queue, leases } = deps;

  if (deps.repos.listEnabled().every((r) => r.id !== deps.repoId)) {
    return;
  }

  if (registry.findById(workerId, deps.repoId)?.status !== 'idle') {
    return;
  }

  leases.reclaimExpired({
    now: deps.now(),
    recoverableRunIds: deps.recoverableRunIds,
    isWorkerAlive: deps.isWorkerAlive,
    resetWorktree: deps.resetWorktree,
    reclaimedByWorkerId: workerId,
    onReclaimed: (info) => {
      if (info.repoId !== deps.repoId) return;
      const jobs = queue.listForRun(info.previousRunId);
      for (const job of jobs) {
        if (job.status === 'claimed' || job.status === 'running') {
          queue.resetToQueued(job.id);
        }
      }
      deps.onLeaseReclaimed?.(info);
    },
  });

  const skippedJobIds = new Set<JobId>();

  while (true) {
    deps.onProgress?.();

    const job = queue.claimNext({
      workerId,
      repoId: deps.repoId,
      skipJobIds: skippedJobIds,
      ttlMs: deps.ttlMs,
    });

    if (!job) {
      return;
    }

    if (job.repoId !== deps.repoId) {
      queue.releaseClaim(job.id);
      skippedJobIds.add(job.id);
      continue;
    }

    const repo = deps.repos.findById(deps.repoId);
    if (!repo || !repo.enabled) {
      queue.releaseClaim(job.id);
      return;
    }

    const outcome = await runClaimedJob(workerId, job, deps, skippedJobIds);

    if (outcome === 'lease_conflict') {
      const afterConflict = registry.findById(workerId, deps.repoId);
      if (afterConflict && isRunnable(afterConflict.status)) {
        registry.markIdle(workerId, deps.repoId);
        continue;
      }
    }
    return;
  }
}
