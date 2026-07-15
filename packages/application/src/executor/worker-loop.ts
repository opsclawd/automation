import type { WorkerId, JobId, RepositoryId, RunId, Run, Job } from '@ai-sdlc/domain';
import type {
  WorkerRegistryPort,
  JobQueuePort,
  WorkerLeasePort,
  RepositoryPort,
  RunRepositoryUpdatePatch,
  RepositoryAvailabilityPort,
} from '../ports.js';
import {
  WorkerLeaseConflictError,
  LeaseOwnershipLostError,
  JobOwnershipLostError,
  generateJobOwnership,
} from '@ai-sdlc/domain';

export type AbortReason = 'shutdown' | 'user_cancelled' | 'lease_lost' | 'repository_unavailable';

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
  isWorkerAlive(workerId: WorkerId): boolean;
  now: () => Date;
  ttlMs: number;
  executeRunGraceMs?: number;
  findRun: (runId: RunId) => Run | undefined;
  updateRun(runId: RunId, patch: RunRepositoryUpdatePatch): void;
  onProgress?: () => void;
  outerSignal?: AbortSignal;
  heartbeatIntervalMs?: number;
  checkPid?(pid: number): boolean;
  registryWorkerHostname?(workerId: WorkerId, repoId: RepositoryId): string | undefined;
  worktreeRecovery?: import('../ports/worktree-recovery-port.js').WorktreeRecoveryPort;
  operationalRecovery?: import('../ports/operational-recovery-port.js').OperationalRecoveryPort;
  getWorktreePath?(repoId: RepositoryId): string;
  getQuarantineRoot?(repoId: RepositoryId): string;
  listRunsForRepo?(repoId: RepositoryId): Run[];
  repoAvailability?: RepositoryAvailabilityPort;
  markStopping?: () => void;
  getAbortReason?(): AbortReason | undefined;
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

  if (!job.claimToken) {
    throw new Error(`job ${job.id} has no claimToken - cannot run without ownership`);
  }

  const ownership = generateJobOwnership(job, workerId);

  let started = false;
  let acquired = false;
  let acquiredLease;
  const abortReason =
    deps.getAbortReason?.() ?? (deps.outerSignal?.aborted ? 'user_cancelled' : undefined);

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

    if (deps.outerSignal) {
      deps.outerSignal.addEventListener(
        'abort',
        () => {
          abortController.abort(abortReason ?? 'user_cancelled');
        },
        { once: true },
      );
    }

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
          abortController.abort('lease_lost');
        }
      },
      Math.max(Math.floor(deps.ttlMs / 2), deps.heartbeatIntervalMs ?? 1_000),
    );

    try {
      queue.markRunning(ownership, deps.now());
      started = true;

      const worktree = await Promise.race([
        deps.prepareWorktree({
          repoId: job.repoId,
          runId: job.runId,
          signal: abortController.signal,
        }),
        new Promise<never>((_, reject) => {
          if (abortController.signal.aborted) {
            reject(new Error('aborted during worktree preparation'));
            return;
          }
          abortController.signal.addEventListener(
            'abort',
            () => reject(new Error('aborted during worktree preparation')),
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
        let settled = false;

        const onAbort = (reason: unknown) => {
          const abortReasonStr = typeof reason === 'string' ? reason : 'unknown';
          if (abortReasonStr === 'shutdown') {
            graceTimer = setTimeout(
              () => reject(new Error('grace expired during shutdown')),
              deps.executeRunGraceMs ?? 10_000,
            );
            void executeRunPromise.then(
              () => {
                if (!settled) {
                  settled = true;
                  clearTimeout(graceTimer);
                  reject(new Error('cooperative shutdown: execution settled'));
                }
              },
              (err) => {
                if (!settled) {
                  settled = true;
                  clearTimeout(graceTimer);
                  reject(
                    new Error(`cooperative shutdown: execution failed - ${(err as Error).message}`),
                  );
                }
              },
            );
          } else {
            graceTimer = setTimeout(
              () => reject(new Error('grace expired')),
              deps.executeRunGraceMs ?? 10_000,
            );
            void executeRunPromise.then(
              () => {
                clearTimeout(graceTimer);
                reject(new Error('heartbeat failed during job execution'));
              },
              (err) => {
                clearTimeout(graceTimer);
                reject(
                  new Error(`heartbeat failed during job execution: ${(err as Error).message}`),
                );
              },
            );
          }
        };

        if (abortController.signal.aborted) {
          onAbort(abortController.signal.reason);
          return;
        }

        abortController.signal.addEventListener(
          'abort',
          () => onAbort(abortController.signal.reason),
          { once: true },
        );

        void executeRunPromise.then(
          (r) => {
            if (!abortController.signal.aborted) {
              abortController.signal.removeEventListener('abort', onAbort as () => void);
              resolve(r);
            }
          },
          (err) => {
            if (!abortController.signal.aborted) {
              abortController.signal.removeEventListener('abort', onAbort as () => void);
              reject(err as Error);
            }
          },
        );
      });

      if (result.ok) {
        queue.markSucceeded(ownership, deps.now());
      } else {
        queue.markFailed(ownership, deps.now());
      }
      return 'settled';
    } finally {
      clearInterval(heartbeatInterval);
    }
  } catch (err) {
    const reason =
      deps.getAbortReason?.() ?? (deps.outerSignal?.aborted ? 'user_cancelled' : undefined);

    if (err instanceof JobOwnershipLostError) {
      return 'settled';
    }
    if (err instanceof WorkerLeaseConflictError) {
      try {
        queue.releaseClaim(ownership);
      } catch (e) {
        if (!(e instanceof JobOwnershipLostError)) throw e;
      }
      skippedJobIds?.add(job.id);
      return 'lease_conflict';
    }
    if (started) {
      if (reason === 'shutdown') {
        try {
          queue.resetToQueued(ownership);
        } catch {
          /* already terminal */
        }
      } else if (reason === 'user_cancelled') {
        try {
          queue.markCancelled(ownership, deps.now());
        } catch {
          /* already terminal */
        }
      } else {
        try {
          queue.markFailed(ownership, deps.now());
        } catch (e) {
          if (!(e instanceof JobOwnershipLostError)) throw e;
        }
      }
    } else {
      try {
        queue.releaseClaim(ownership);
      } catch (e) {
        if (!(e instanceof JobOwnershipLostError)) throw e;
      }
    }
    return 'settled';
  } finally {
    const reason =
      deps.getAbortReason?.() ?? (deps.outerSignal?.aborted ? 'user_cancelled' : undefined);

    if (acquired && acquiredLease) {
      if (reason === 'lease_lost') {
        // For lease_lost (non-cooperative shutdown), preserve the lease for startup recovery
      } else {
        try {
          leases.release({
            repoId: job.repoId,
            workerId,
            runId: job.runId,
            leaseToken: acquiredLease.leaseToken,
          });
        } catch (err) {
          if (!(err instanceof LeaseOwnershipLostError)) throw err;
        }
      }
    }
    const afterRelease = registry.findById(workerId, deps.repoId);
    if (afterRelease && isRunnable(afterRelease.status)) {
      if (reason === 'shutdown') {
        deps.markStopping?.();
      }
      registry.markIdle(workerId, deps.repoId);
    }
  }
}

export async function workerLoop(workerId: WorkerId, deps: WorkerLoopDeps): Promise<void> {
  const { registry, queue } = deps;

  if (deps.repos.listEnabled().every((r) => r.id !== deps.repoId)) {
    return;
  }

  if (registry.findById(workerId, deps.repoId)?.status !== 'idle') {
    return;
  }

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
      if (job.claimToken) {
        try {
          queue.releaseClaim(generateJobOwnership(job, workerId));
        } catch (e) {
          if (!(e instanceof JobOwnershipLostError)) throw e;
        }
      }
      skippedJobIds.add(job.id);
      continue;
    }

    const repo = deps.repos.findById(deps.repoId);
    if (!repo || !repo.enabled) {
      if (job.claimToken) {
        try {
          queue.releaseClaim(generateJobOwnership(job, workerId));
        } catch (e) {
          if (!(e instanceof JobOwnershipLostError)) throw e;
        }
      }
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
