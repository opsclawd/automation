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
  private cachedRuntimes = new Map<RepositoryId, RepositoryRuntime>();

  constructor(deps: RepositorySchedulerAdapterDeps) {
    this.deps = deps;
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
      runtime = this.cachedRuntimes.get(repo.id) ?? (await this.deps.runtimeFactory(repo));
      if (!this.cachedRuntimes.has(repo.id)) {
        this.cachedRuntimes.set(repo.id, runtime);
      }
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

    let runtime = this.cachedRuntimes.get(repository.id);
    if (!runtime) {
      runtime = await this.deps.runtimeFactory(repository);
      this.cachedRuntimes.set(repository.id, runtime);
    }

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
      runtime.workerRegistry.heartbeat(workerId, repository.id, new Date());
    }, 30_000);

    try {
      const jobs = runtime.jobQueue.listForRepo(repository.id);
      const queuedJobs = jobs.filter((j) => j.status === 'queued');

      if (queuedJobs.length === 0) {
        return 'no_work';
      }

      const firstJob = queuedJobs[0];
      if (!firstJob) {
        return 'no_work';
      }

      const workerLoopFn = this.deps.workerLoop ?? defaultWorkerLoop;
      await workerLoopFn(runtime, { workerId, runId: firstJob.runId });

      return 'completed';
    } finally {
      clearInterval(heartbeatInterval);
      runtime.workerRegistry.markIdle(workerId, repository.id);
    }
  }

  close(): void {
    for (const runtime of this.cachedRuntimes.values()) {
      runtime.close();
    }
    this.cachedRuntimes.clear();
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
