import type { WorkerId, JobId, RepositoryId, RunId, Run } from '@ai-sdlc/domain';
import type {
  WorkerRegistryPort,
  JobQueuePort,
  WorkerLeasePort,
  RepositoryPort,
} from '../ports.js';
import { WorkerLeaseConflictError } from '@ai-sdlc/domain';

const EXECUTE_RUN_GRACE_MS = 10_000;

export interface WorkerLoopDeps {
  registry: WorkerRegistryPort;
  queue: JobQueuePort;
  leases: WorkerLeasePort;
  repos: RepositoryPort;
  executeRun: (input: {
    run: Run;
    workerId: WorkerId;
    cwd: string;
    signal: AbortSignal;
  }) => Promise<{ ok: boolean }>;
  prepareWorktree: (input: {
    repoId: RepositoryId;
    runId: RunId;
    signal?: AbortSignal;
  }) => Promise<{ cwd: string }>;
  resetWorktree: (repoId: RepositoryId) => void;
  isWorkerAlive: (workerId: WorkerId) => boolean;
  recoverableRunIds: ReadonlySet<RunId>;
  now: () => Date;
  ttlMs: number;
  findRun: (runId: RunId) => Run | undefined;
  onLeaseReclaimed?: (info: {
    repoId: RepositoryId;
    previousWorkerId: WorkerId;
    previousRunId: RunId;
    reclaimedByWorkerId: WorkerId;
    reason: string;
  }) => void;
}

function isRunnable(status: string): boolean {
  return status === 'idle' || status === 'busy';
}

export async function workerLoop(workerId: WorkerId, deps: WorkerLoopDeps): Promise<void> {
  const { registry, queue, leases } = deps;

  if (registry.findById(workerId)?.status !== 'idle') {
    return;
  }

  leases.reclaimExpired({
    now: deps.now(),
    recoverableRunIds: deps.recoverableRunIds,
    isWorkerAlive: deps.isWorkerAlive,
    resetWorktree: deps.resetWorktree,
    reclaimedByWorkerId: workerId,
    onReclaimed: (info) => {
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
    const job = queue.claimNext({ workerId, skipJobIds: skippedJobIds });
    if (!job) {
      return;
    }

    let started = false;
    let acquired = false;

    try {
      registry.markBusy(workerId);

      leases.acquire({
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
            leases.heartbeat(job.repoId, workerId, now, new Date(now.getTime() + deps.ttlMs));
          } catch {
            clearInterval(heartbeatInterval);
            abortController.abort();
          }
        },
        Math.max(Math.floor(deps.ttlMs / 2), 1_000),
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
              EXECUTE_RUN_GRACE_MS,
            );
            void executeRunPromise.then(
              () => {
                clearTimeout(graceTimer);
                reject(new Error('heartbeat failed during job execution'));
              },
              () => {
                clearTimeout(graceTimer);
                reject(new Error('heartbeat failed during job execution'));
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
        return;
      } finally {
        clearInterval(heartbeatInterval);
      }
    } catch (err) {
      if (err instanceof WorkerLeaseConflictError) {
        queue.releaseClaim(job.id);
        skippedJobIds.add(job.id);
        const afterConflict = registry.findById(workerId);
        if (afterConflict && isRunnable(afterConflict.status)) {
          registry.markIdle(workerId);
          continue;
        }
        return;
      }
      if (started) {
        queue.markFailed(job.id, deps.now());
      } else {
        queue.releaseClaim(job.id);
      }
      return;
    } finally {
      // Only release a lease this tick actually acquired. If acquire() threw a
      // WorkerLeaseConflictError for a lease already held by this same workerId
      // (e.g. a worker process restarted and re-registered before its prior
      // unexpired lease was reclaimed), releasing it here would drop a lease we
      // never owned this tick — bypassing the reclaim safety path and leaving
      // the repo unprotected with the prior run still active.
      if (acquired) {
        leases.release(job.repoId, workerId);
      }
      const afterRelease = registry.findById(workerId);
      if (afterRelease && isRunnable(afterRelease.status)) {
        registry.markIdle(workerId);
      }
    }
  }
}
