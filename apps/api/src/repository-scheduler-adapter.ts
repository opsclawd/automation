import type {
  RepositoryWorkSourcePort,
  RepositoryDispatchPort,
  RepositoryWorkInspection,
  LoggerPort,
} from '@ai-sdlc/application/ports';
import type { Repository, RepositoryId, WorkerId, RunId, Worker } from '@ai-sdlc/domain';
import {
  LeaseOwnershipLostError,
  JobOwnershipLostError,
  WorkerLeaseConflictError,
  generateJobOwnership,
} from '@ai-sdlc/domain';
import type { RepositoryRuntime } from './repository-runtime-factory.js';

export interface RepositorySchedulerAdapterDeps {
  runtimeFactory: (repo: Repository) => Promise<RepositoryRuntime>;
  logger: LoggerPort;
  workerLoop?: (
    deps: RepositoryRuntime,
    input: { workerId: WorkerId; runId: RunId; signal?: AbortSignal },
  ) => Promise<'completed' | 'no_work' | void>;
}

export class RepositorySchedulerAdapter
  implements RepositoryWorkSourcePort, RepositoryDispatchPort
{
  private readonly deps: RepositorySchedulerAdapterDeps;
  private cachedRuntimePromises = new Map<RepositoryId, Promise<RepositoryRuntime>>();
  private cachedRuntimes = new Map<RepositoryId, RepositoryRuntime>();
  private closed = false;
  private activeDispatches = new Set<WorkerId>();

  constructor(deps: RepositorySchedulerAdapterDeps) {
    this.deps = deps;
  }

  private getOrCreateRuntimePromise(repo: Repository): Promise<RepositoryRuntime> {
    const existing = this.cachedRuntimePromises.get(repo.id);
    if (existing) return existing;

    const promise = this.deps.runtimeFactory(repo).then((runtime) => {
      if (this.closed) {
        runtime.close();
        throw new Error(
          `repository scheduler adapter closed while constructing runtime for ${repo.id}`,
        );
      }
      this.cachedRuntimes.set(repo.id, runtime);
      return runtime;
    });

    promise.catch(() => {
      if (this.cachedRuntimePromises.get(repo.id) === promise) {
        this.cachedRuntimePromises.delete(repo.id);
      }
    });

    this.cachedRuntimePromises.set(repo.id, promise);
    return promise;
  }

  async inspect(repo: Repository): Promise<RepositoryWorkInspection> {
    if (!repo.enabled) {
      return {
        available: false,
        reason: 'disabled',
        detail: `Repository ${repo.fullName} is disabled`,
      };
    }

    if (repo.healthStatus === 'degraded') {
      return {
        available: false,
        reason: 'unhealthy',
        detail: repo.healthError ?? 'degraded',
      };
    }

    if (repo.healthStatus === 'unreachable') {
      return {
        available: false,
        reason: 'unavailable',
        detail: repo.healthError ?? 'unreachable',
      };
    }

    if (repo.healthStatus === 'unknown') {
      return {
        available: false,
        reason: 'unavailable',
        detail: repo.healthError ?? 'unknown health status',
      };
    }

    let runtime: RepositoryRuntime;
    try {
      runtime = await this.getOrCreateRuntimePromise(repo);
    } catch (err) {
      return {
        available: false,
        reason: 'unavailable',
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    const jobs = runtime.jobQueue.listForRepo(repo.id);
    const queuedJobs = jobs.filter((j) => j.status === 'queued');
    const runningJobs = jobs.filter((j) => j.status === 'running');
    const hasActiveLease =
      runtime.workerLeaseRepository?.checkActiveLease(repo.id, new Date()) ?? false;
    const activeCount = Math.max(runningJobs.length, hasActiveLease ? 1 : 0);

    return {
      available: true,
      queueDepth: queuedJobs.length,
      activeCount,
    };
  }

  async runOne(input: {
    repository: Repository;
    workerId: WorkerId;
    signal?: AbortSignal;
  }): Promise<'completed' | 'no_work'> {
    const { repository, workerId, signal } = input;

    const runtimePromise = this.getOrCreateRuntimePromise(repository);

    this.activeDispatches.add(workerId);
    try {
      const runtime = await runtimePromise;

      const hostname = 'scheduler';
      const processId = 0;
      const worker: Worker = {
        id: workerId,
        repoId: repository.id,
        hostname,
        processId,
        status: 'idle',
        heartbeatAt: new Date(),
      };
      runtime.workerRegistry.register(worker);

      const heartbeatInterval = setInterval(() => {
        try {
          runtime.workerRegistry.heartbeat(workerId, repository.id, new Date());
        } catch (err) {
          this.deps.logger.error('worker heartbeat failed', { err });
        }
      }, 30_000);

      try {
        const claimedJob = runtime.jobQueue.claimNext({
          workerId,
          repoId: repository.id,
          ttlMs: 120_000,
        });

        if (!claimedJob) {
          return 'no_work';
        }

        const workerLoopInput: { workerId: WorkerId; runId: RunId; signal?: AbortSignal } = {
          workerId,
          runId: claimedJob.runId,
        };
        if (signal) {
          workerLoopInput.signal = signal;
        }
        const workerLoopFn = this.deps.workerLoop ?? defaultWorkerLoop;
        const outcome = await workerLoopFn(runtime, workerLoopInput);
        if (outcome === 'no_work') {
          return 'no_work';
        }

        return 'completed';
      } finally {
        clearInterval(heartbeatInterval);
        this.activeDispatches.delete(workerId);
        try {
          runtime.workerRegistry.deregister(workerId);
        } catch {
          // ignore
        }
        if (this.closed && this.activeDispatches.size === 0) {
          for (const rt of this.cachedRuntimes.values()) {
            rt.close();
          }
          this.cachedRuntimes.clear();
          this.cachedRuntimePromises.clear();
        }
      }
    } catch (err) {
      this.activeDispatches.delete(workerId);
      if (this.closed && this.activeDispatches.size === 0) {
        for (const rt of this.cachedRuntimes.values()) {
          rt.close();
        }
        this.cachedRuntimes.clear();
        this.cachedRuntimePromises.clear();
      }
      throw err;
    }
  }

  close(): void {
    this.closed = true;
    if (this.activeDispatches.size === 0) {
      for (const runtime of this.cachedRuntimes.values()) {
        runtime.close();
      }
      this.cachedRuntimes.clear();
      this.cachedRuntimePromises.clear();
    }
  }
}

async function defaultWorkerLoop(
  runtime: RepositoryRuntime,
  input: { workerId: WorkerId; runId: RunId; signal?: AbortSignal },
): Promise<'completed' | 'no_work'> {
  const { runRepository, jobQueue, workerLeaseRepository } = runtime;
  const { workerId, runId, signal } = input;

  const job = jobQueue
    .listForRun(runId)
    .find((j) => j.claimedBy === workerId && j.status === 'claimed');
  if (!job) {
    return 'no_work';
  }

  if (signal?.aborted) {
    if (job.claimedBy && job.claimToken) {
      try {
        jobQueue.markFailed(generateJobOwnership(job, job.claimedBy), new Date());
      } catch (err) {
        if (!(err instanceof JobOwnershipLostError)) throw err;
      }
    }
    return 'no_work';
  }

  const run = runRepository.findByUuid(String(runId));
  if (!run) {
    if (job.claimedBy && job.claimToken) {
      try {
        jobQueue.markFailed(generateJobOwnership(job, job.claimedBy), new Date());
      } catch (err) {
        if (!(err instanceof JobOwnershipLostError)) throw err;
      }
    }
    return 'no_work';
  }

  const now = new Date();
  let acquiredLease;
  try {
    acquiredLease = workerLeaseRepository.acquire({
      repoId: job.repoId,
      workerId: input.workerId,
      runId,
      now,
      ttlMs: 120_000,
    });
  } catch (err) {
    if (err instanceof WorkerLeaseConflictError) {
      if (job.claimedBy && job.claimToken) {
        try {
          jobQueue.releaseClaim(generateJobOwnership(job, job.claimedBy));
        } catch (e) {
          if (!(e instanceof JobOwnershipLostError)) throw e;
        }
      }
      return 'no_work';
    }
    throw err;
  }

  try {
    if (job.claimedBy && job.claimToken) {
      try {
        jobQueue.markRunning(generateJobOwnership(job, job.claimedBy), now);
      } catch (err) {
        if (!(err instanceof JobOwnershipLostError)) throw err;
      }
    }
    return 'completed';
  } finally {
    try {
      workerLeaseRepository.release({
        repoId: job.repoId,
        workerId: input.workerId,
        runId,
        leaseToken: acquiredLease.leaseToken,
      });
    } catch (err) {
      if (!(err instanceof LeaseOwnershipLostError)) throw err;
    }
  }
}
