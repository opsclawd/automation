import type {
  ReleaseBatchNotificationPort,
  ReleaseBatchNotification,
} from '@ai-sdlc/application/ports';

export class NoopReleaseBatchNotificationAdapter implements ReleaseBatchNotificationPort {
  async notify(_event: ReleaseBatchNotification): Promise<void> {}
  async drain(_timeoutMs?: number): Promise<void> {}
}
