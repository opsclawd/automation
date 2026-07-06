import { workerLoop, type WorkerLoopDeps } from '@ai-sdlc/application';
import type { JobQueuePort } from '@ai-sdlc/application/ports';
import { type Job, type WorkerId, type JobId, type RunId } from '@ai-sdlc/domain';

function buildRecoverableRunIds(queue: JobQueuePort): ReadonlySet<RunId> {
  const activeJobs = queue.listActive();
  return new Set(activeJobs.map((j) => j.runId));
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

function isTerminal(status: Job['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

export class WorkerScheduler {
  constructor(
    private readonly workerIds: WorkerId[],
    private readonly baseDeps: Omit<WorkerLoopDeps, 'recoverableRunIds'>,
    private readonly tickIntervalMs = 2_000,
    private readonly workerTimeoutMs = 15 * 60_000,
  ) {}

  /**
   * Starts the long-lived multi-repository scheduler loop.
   * Continues until the signal is aborted.
   */
  async start(signal: AbortSignal): Promise<void> {
    const { queue, repos, registry } = this.baseDeps;
    let repoIndex = 0;

    while (!signal.aborted) {
      // Reclaim jobs that haven't heartbeated for a while.
      // 10 minutes is a safer default given 30s heartbeats and 120s TTLs.
      const reclaimCutoff = new Date(Date.now() - 10 * 60_000);
      queue.reclaimStaleClaims(reclaimCutoff);

      const enabledRepos = repos.listEnabled();
      if (enabledRepos.length > 0) {
        const recoverableRunIds = buildRecoverableRunIds(queue);

        // Attempt to fill all idle workers in a single tick.
        let idleWorkers = this.workerIds.filter((wid) => registry.findById(wid)?.status === 'idle');

        for (let i = 0; i < enabledRepos.length && idleWorkers.length > 0; i++) {
          const repo = enabledRepos[(repoIndex + i) % enabledRepos.length]!;

          // Count truly active runs (not just queued jobs).
          const activeJobs = queue.listForRepo(repo.id).filter((j) => j.status === 'running');

          if (activeJobs.length < repo.maxConcurrentRuns) {
            const workerId = idleWorkers.shift()!;
            void workerLoop(workerId, {
              ...this.baseDeps,
              recoverableRunIds,
              outerSignal: signal,
              repoId: repo.id,
            }).catch((err) => {
              console.error(`workerLoop ${workerId} failed:`, err);
            });
          }
        }
        repoIndex = (repoIndex + 1) % enabledRepos.length;
      }

      await sleep(this.tickIntervalMs, signal);
    }
  }

  async runUntilComplete(jobId: JobId, signal: AbortSignal): Promise<void> {
    const reclaimCutoff = new Date(Date.now() - 10 * 60_000);
    while (!signal.aborted) {
      const job = this.baseDeps.queue.findById(jobId);
      if (!job) throw new Error(`Job ${jobId} not found`);
      if (isTerminal(job.status)) return;

      this.baseDeps.queue.reclaimStaleClaims(reclaimCutoff);

      const recoverableRunIds = buildRecoverableRunIds(this.baseDeps.queue);

      const timeoutMs = this.workerTimeoutMs;
      const results = await Promise.allSettled(
        this.workerIds.map((wid) => {
          let t: NodeJS.Timeout | undefined;
          const timeoutPromise = new Promise<never>((_, reject) => {
            if (signal.aborted) {
              reject(new Error(`aborted before tick`));
              return;
            }
            t = setTimeout(
              () => reject(new Error(`workerLoop ${wid} timed out after ${timeoutMs}ms`)),
              timeoutMs,
            );
            signal.addEventListener(
              'abort',
              () => {
                if (t) clearTimeout(t);
                reject(new Error(`aborted during tick`));
              },
              { once: true },
            );
          });

          return Promise.race([
            workerLoop(wid, {
              ...this.baseDeps,
              recoverableRunIds,
              outerSignal: signal,
              onProgress: () => t?.refresh(),
            }),
            timeoutPromise,
          ]).finally(() => {
            if (t) clearTimeout(t);
          });
        }),
      );
      for (const result of results) {
        if (result.status === 'rejected') {
          throw result.reason instanceof Error ? result.reason : new Error(String(result.reason));
        }
      }

      const updated = this.baseDeps.queue.findById(jobId);
      if (!updated || isTerminal(updated.status)) return;

      if (signal.aborted) {
        if (updated.status === 'claimed') {
          this.baseDeps.queue.releaseClaim(jobId);
        } else if (updated.status === 'running') {
          try {
            this.baseDeps.queue.markCancelled(jobId, new Date());
          } catch {
            /* already terminal */
          }
        }
        return;
      }

      await sleep(this.tickIntervalMs, signal);
    }
  }
}
