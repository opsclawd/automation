import type {
  RepositoryWorkSourcePort,
  RepositoryDispatchPort,
  RepositoryWorkInspection,
  LoggerPort,
} from '@ai-sdlc/application/ports';
import type { Repository, RepositoryId, WorkerId, RunId, Worker } from '@ai-sdlc/domain';
import type { RepositoryRuntime } from './repository-runtime-factory.js';

export interface RepositorySchedulerAdapterDeps {
  repoId: RepositoryId;
  runtimeFactory: (repo: Repository) => Promise<RepositoryRuntime>;
  logger: LoggerPort;
  workerLoop?: (
    deps: RepositoryRuntime,
    input: { workerId: WorkerId; runId: RunId },
  ) => Promise<void>;
}

export class RepositorySchedulerAdapter
  implements RepositoryWorkSourcePort, RepositoryDispatchPort
{
  private readonly deps: RepositorySchedulerAdapterDeps;
  private cachedRuntimePromises = new Map<RepositoryId, Promise<RepositoryRuntime>>();
  private cachedRuntimes = new Map<RepositoryId, RepositoryRuntime>();

  constructor(deps: RepositorySchedulerAdapterDeps) {
    this.deps = deps;
  }

  private getOrCreateRuntimePromise(repo: Repository): Promise<RepositoryRuntime> {
    const existing = this.cachedRuntimePromises.get(repo.id);
    if (existing) return existing;

    const promise = this.deps.runtimeFactory(repo).then((runtime) => {
      this.cachedRuntimes.set(repo.id, runtime);
      return runtime;
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
    const activeCount = runningJobs.length;

    return {
      available: true,
      queueDepth: queuedJobs.length,
      activeCount,
    };
  }

  async runOne(input: {
    repository: Repository;
    workerId: WorkerId;
  }): Promise<'completed' | 'no_work'> {
    const { repository, workerId } = input;

    const runtimePromise = this.getOrCreateRuntimePromise(repository);
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

      const workerLoopFn = this.deps.workerLoop ?? defaultWorkerLoop;
      await workerLoopFn(runtime, { workerId, runId: claimedJob.runId });

      return 'completed';
    } finally {
      clearInterval(heartbeatInterval);
      runtime.workerRegistry.deregister(workerId);
    }
  }

  close(): void {
    for (const runtime of this.cachedRuntimes.values()) {
      runtime.close();
    }
    this.cachedRuntimes.clear();
    this.cachedRuntimePromises.clear();
  }
}

async function defaultWorkerLoop(
  runtime: RepositoryRuntime,
  input: { workerId: WorkerId; runId: RunId },
): Promise<void> {
  const { runRepository, jobQueue, workerLeaseRepository } = runtime;
  const { runId } = input;

  const run = runRepository.findByUuid(String(runId));
  if (!run) {
    return;
  }

  const job = jobQueue.findById(runId as unknown as import('@ai-sdlc/domain').JobId);
  if (!job) {
    return;
  }

  const now = new Date();
  workerLeaseRepository.acquire({
    repoId: job.repoId,
    workerId: input.workerId,
    runId,
    now,
    ttlMs: 120_000,
  });

  try {
    jobQueue.markRunning(job.id, now);
  } finally {
    workerLeaseRepository.release({
      repoId: job.repoId,
      workerId: input.workerId,
      runId,
    });
  }
}
