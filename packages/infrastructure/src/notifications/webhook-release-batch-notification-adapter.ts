import type {
  ReleaseBatchNotificationPort,
  ReleaseBatchNotification,
  LoggerPort,
} from '@ai-sdlc/application/ports';
import { DEFAULT_RELEASE_BATCH_NOTIFICATION_TIMEOUT_MS } from '@ai-sdlc/application/ports';

export const DEFAULT_RELEASE_BATCH_WEBHOOK_TIMEOUT_MS =
  DEFAULT_RELEASE_BATCH_NOTIFICATION_TIMEOUT_MS;
export const DEFAULT_RELEASE_BATCH_DRAIN_TIMEOUT_MS = DEFAULT_RELEASE_BATCH_WEBHOOK_TIMEOUT_MS;

export function formatReleaseBatchNotificationMessage(event: ReleaseBatchNotification): string {
  const base = `[release-batch:${event.type}] ${event.repoId} (${event.batchId}) branch=${event.releaseBranch}`;
  const details: string[] = [];
  if (event.candidateSha) details.push(`candidate=${event.candidateSha}`);
  if (event.promotionPrNumber) details.push(`pr=#${event.promotionPrNumber}`);
  if (event.reason) details.push(`reason=${event.reason}`);
  return details.length > 0 ? `${base}: ${details.join(' ')}` : base;
}

export class WebhookReleaseBatchNotificationAdapter implements ReleaseBatchNotificationPort {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly webhookUrl: string,
    private readonly logger?: LoggerPort,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs: number = DEFAULT_RELEASE_BATCH_WEBHOOK_TIMEOUT_MS,
  ) {}

  async notify(event: ReleaseBatchNotification): Promise<void> {
    const promise = this.sendNotification(event);
    this.pending.add(promise);
    promise.finally(() => {
      this.pending.delete(promise);
    });
    return promise;
  }

  private async sendNotification(event: ReleaseBatchNotification): Promise<void> {
    const message = formatReleaseBatchNotificationMessage(event);
    try {
      const signal = AbortSignal.timeout(this.timeoutMs);
      const res = await this.fetchImpl(this.webhookUrl, {
        method: 'POST',
        body: message,
        signal,
      });
      if (!res.ok) {
        this.logger?.warn(
          `release-batch notification webhook returned non-2xx status`,
          `status=${res.status}`,
        );
      }
    } catch (err) {
      this.logger?.warn(
        `release-batch notification webhook request failed`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async drain(
    timeoutMs = Math.max(DEFAULT_RELEASE_BATCH_DRAIN_TIMEOUT_MS, this.timeoutMs),
  ): Promise<void> {
    if (this.pending.size === 0) {
      return;
    }
    const allSettled = Promise.allSettled(Array.from(this.pending));
    if (timeoutMs <= 0) {
      await allSettled;
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      const effectiveTimeout = timeoutMs >= this.timeoutMs ? timeoutMs + 100 : timeoutMs;
      timer = setTimeout(resolve, effectiveTimeout);
    });
    try {
      await Promise.race([allSettled, timeoutPromise]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}
