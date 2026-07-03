import { workerLoop, type WorkerLoopDeps } from '@ai-sdlc/application';
import type { JobQueuePort, RepositoryPort } from '@ai-sdlc/application/ports';
import type { Job, WorkerId, JobId, RunId } from '@ai-sdlc/domain';

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

  async runUntilComplete(jobId: JobId, signal: AbortSignal): Promise<void> {
    const reclaimCutoff = new Date(Date.now() - this.tickIntervalMs * 6);
    while (!signal.aborted) {
      const job = this.baseDeps.queue.findById(jobId);
      if (!job) throw new Error(`Job ${jobId} not found`);
      if (isTerminal(job.status)) return;

      this.baseDeps.queue.reclaimStaleClaims(reclaimCutoff);

      const recoverableRunIds = buildRecoverableRunIds(this.baseDeps.queue, this.baseDeps.repos);
      const deps: WorkerLoopDeps = { ...this.baseDeps, recoverableRunIds, outerSignal: signal };

      // workerLoop runs the real executor (prepareWorktree/executeRun), which can
      // legitimately take minutes, so this timeout guards only against a truly
      // hung worker and must not be tied to the (much shorter) tick interval.
      const timeoutMs = this.workerTimeoutMs;
      const results = await Promise.allSettled(
        this.workerIds.map((wid) =>
          Promise.race([
            workerLoop(wid, deps),
            new Promise<never>((_, reject) => {
              if (signal.aborted) {
                reject(new Error(`aborted before tick`));
                return;
              }
              const t = setTimeout(
                () => reject(new Error(`workerLoop ${wid} timed out after ${timeoutMs}ms`)),
                timeoutMs,
              );
              signal.addEventListener(
                'abort',
                () => {
                  clearTimeout(t);
                  reject(new Error(`aborted during tick`));
                },
                { once: true },
              );
            }),
          ]),
        ),
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
