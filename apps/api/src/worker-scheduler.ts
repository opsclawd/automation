import { workerLoop, type WorkerLoopDeps } from '@ai-sdlc/application';
import type { JobQueuePort, RepositoryPort } from '@ai-sdlc/application/ports';
import type { Job, WorkerId, JobId, RunId } from '@ai-sdlc/domain';
import { generateJobOwnership, JobOwnershipLostError } from '@ai-sdlc/domain';

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
    while (!signal.aborted) {
      const job = this.baseDeps.queue.findById(jobId);
      if (!job) throw new Error(`Job ${jobId} not found`);
      if (isTerminal(job.status)) return;

      const recoverableRunIds = buildRecoverableRunIds(this.baseDeps.queue, this.baseDeps.repos);

      // workerLoop runs the real executor (prepareWorktree/executeRun), which can
      // legitimately take minutes, so this timeout guards only against a truly
      // hung worker and must not be tied to the (much shorter) tick interval.
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
              // The worker loop calls onProgress during its lease heartbeat.
              // We refresh the watchdog timer to allow the run to continue
              // as long as heartbeats are being maintained.
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
        if (updated.status === 'claimed' && updated.claimedBy && updated.claimToken) {
          try {
            this.baseDeps.queue.releaseClaim(generateJobOwnership(updated, updated.claimedBy));
          } catch (err) {
            if (!(err instanceof JobOwnershipLostError)) throw err;
          }
        } else if (updated.status === 'running' && updated.claimedBy && updated.claimToken) {
          try {
            this.baseDeps.queue.markCancelled(
              generateJobOwnership(updated, updated.claimedBy),
              new Date(),
            );
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
