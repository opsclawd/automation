import type { RepositoryId } from '@ai-sdlc/domain';

export const DEFAULT_NOTIFICATION_TIMEOUT_MS = 10_000;
export const DEFAULT_DRAIN_TIMEOUT_MS = DEFAULT_NOTIFICATION_TIMEOUT_MS;

export type RunTerminalStatus = 'passed' | 'failed' | 'blocked' | 'needs_human_review';

export interface RunTerminalNotification {
  status: RunTerminalStatus;
  repoId: RepositoryId;
  issueNumber: number;
  displayId: string;
  failureReason?: string;
}

export interface RunNotificationPort {
  notify(event: RunTerminalNotification): Promise<void>;
  drain?(timeoutMs?: number): Promise<void>;
}

export function safeDispatchRunNotification(
  notification: RunNotificationPort | undefined,
  event: RunTerminalNotification,
  logger?: { warn: (msg: string, ...args: unknown[]) => void },
): void {
  if (!notification) return;
  try {
    notification.notify(event).catch((err) => {
      logger?.warn('run notification failed', err instanceof Error ? err.message : String(err));
    });
  } catch (err) {
    logger?.warn(
      'run notification threw synchronously',
      err instanceof Error ? err.message : String(err),
    );
  }
}
