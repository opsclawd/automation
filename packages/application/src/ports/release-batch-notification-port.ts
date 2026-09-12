import type { ReleaseBatchId, RepositoryId } from '@ai-sdlc/domain';

export const DEFAULT_RELEASE_BATCH_NOTIFICATION_TIMEOUT_MS = 10_000;
export const DEFAULT_RELEASE_BATCH_DRAIN_TIMEOUT_MS = DEFAULT_RELEASE_BATCH_NOTIFICATION_TIMEOUT_MS;

export type ReleaseBatchNotificationType =
  | 'blocked'
  | 'awaiting_manual_test'
  | 'approval_stale'
  | 'promotion_blocked'
  | 'completed';

export interface ReleaseBatchNotification {
  type: ReleaseBatchNotificationType;
  batchId: ReleaseBatchId;
  repoId: RepositoryId;
  releaseBranch: string;
  candidateSha?: string;
  sourceBranch?: string;
  promotionPrNumber?: number;
  reason?: string;
}

export interface ReleaseBatchNotificationPort {
  notify(event: ReleaseBatchNotification): Promise<void>;
  drain?(timeoutMs?: number): Promise<void>;
}

export function safeDispatchReleaseBatchNotification(
  notification: ReleaseBatchNotificationPort | undefined,
  event: ReleaseBatchNotification,
  logger?: { warn?: (msg: string, ...args: unknown[]) => void },
): void {
  if (!notification) return;
  try {
    notification.notify(event).catch((err) => {
      logger?.warn?.(
        'release-batch notification failed',
        err instanceof Error ? err.message : String(err),
      );
    });
  } catch (err) {
    logger?.warn?.(
      'release-batch notification threw synchronously',
      err instanceof Error ? err.message : String(err),
    );
  }
}
