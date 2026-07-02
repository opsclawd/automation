import { workerLoop, type WorkerLoopDeps } from '@ai-sdlc/application';
import type { JobQueuePort, RepositoryPort } from '@ai-sdlc/application/ports';
import type { WorkerId, JobId, RunId } from '@ai-sdlc/domain';

export type WorkerLoopBaseDeps = Omit<WorkerLoopDeps, 'recoverableRunIds'>;

function buildRecoverableRunIds(queue: JobQueuePort, repos: RepositoryPort): ReadonlySet<RunId> {
  const allJobs = repos.listEnabled().flatMap((r) => queue.listForRepo(r.id));
  return new Set(
    allJobs.filter((j) => j.status === 'claimed' || j.status === 'running').map((j) => j.runId),
  );
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function isTerminal(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

export class WorkerScheduler {
  constructor(
    private readonly workerIds: WorkerId[],
    private readonly baseDeps: WorkerLoopBaseDeps,
    private readonly queue: JobQueuePort,
    private readonly tickIntervalMs = 2_000,
  ) {}

  async runUntilComplete(jobId: JobId, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const job = this.queue.findById(jobId);
      if (!job) throw new Error(`Job ${jobId} not found`);
      if (isTerminal(job.status)) return;

      const recoverableRunIds = buildRecoverableRunIds(this.queue, this.baseDeps.repos);
      const deps: WorkerLoopDeps = { ...this.baseDeps, recoverableRunIds };

      const results = await Promise.allSettled(this.workerIds.map((wid) => workerLoop(wid, deps)));
      for (const result of results) {
        if (result.status === 'rejected') {
          throw result.reason;
        }
      }

      const updated = this.queue.findById(jobId);
      if (!updated || isTerminal(updated.status)) return;

      await sleep(this.tickIntervalMs, signal);
    }
  }
}
