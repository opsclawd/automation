import type {
  RunNotificationPort,
  RunTerminalNotification,
  LoggerPort,
} from '@ai-sdlc/application/ports';
import { DEFAULT_NOTIFICATION_TIMEOUT_MS } from '@ai-sdlc/application/ports';

export const DEFAULT_WEBHOOK_TIMEOUT_MS = DEFAULT_NOTIFICATION_TIMEOUT_MS;
export const DEFAULT_DRAIN_TIMEOUT_MS = DEFAULT_WEBHOOK_TIMEOUT_MS;

export function formatRunNotificationMessage(event: RunTerminalNotification): string {
  const base = `[${event.status}] ${event.repoId}#${event.issueNumber} (${event.displayId})`;
  return event.failureReason ? `${base}: ${event.failureReason}` : base;
}

export class WebhookRunNotificationAdapter implements RunNotificationPort {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly webhookUrl: string,
    private readonly logger?: LoggerPort,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs: number = DEFAULT_WEBHOOK_TIMEOUT_MS,
  ) {}

  async notify(event: RunTerminalNotification): Promise<void> {
    const promise = this.sendNotification(event);
    this.pending.add(promise);
    promise.finally(() => {
      this.pending.delete(promise);
    });
    return promise;
  }

  private async sendNotification(event: RunTerminalNotification): Promise<void> {
    const message = formatRunNotificationMessage(event);
    try {
      const signal = AbortSignal.timeout(this.timeoutMs);
      const res = await this.fetchImpl(this.webhookUrl, {
        method: 'POST',
        body: message,
        signal,
      });
      if (!res.ok) {
        this.logger?.warn(
          `run notification webhook returned non-2xx status`,
          `status=${res.status}`,
        );
      }
    } catch (err) {
      this.logger?.warn(
        `run notification webhook request failed`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async drain(timeoutMs = Math.max(DEFAULT_DRAIN_TIMEOUT_MS, this.timeoutMs)): Promise<void> {
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
