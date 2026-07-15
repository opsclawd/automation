import { workerLoop, type WorkerLoopDeps } from '@ai-sdlc/application';
import type { Job, WorkerId, JobId } from '@ai-sdlc/domain';
import { generateJobOwnership, JobOwnershipLostError } from '@ai-sdlc/domain';

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
