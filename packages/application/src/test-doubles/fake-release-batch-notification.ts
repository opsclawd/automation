import type {
  ReleaseBatchNotificationPort,
  ReleaseBatchNotification,
  ReleaseBatchNotificationType,
} from '../ports/release-batch-notification-port.js';

export class FakeReleaseBatchNotification implements ReleaseBatchNotificationPort {
  public readonly events: ReleaseBatchNotification[] = [];
  public failWith?: Error;
  public synchronousError?: Error;
  public drainCalled = false;

  notify(event: ReleaseBatchNotification): Promise<void> {
    if (this.synchronousError) {
      throw this.synchronousError;
    }
    if (this.failWith) {
      return Promise.reject(this.failWith);
    }
    this.events.push(event);
    return Promise.resolve();
  }

  hasNotification(type: ReleaseBatchNotificationType): boolean {
    return this.events.some((e) => e.type === type);
  }

  async drain(_timeoutMs?: number): Promise<void> {
    this.drainCalled = true;
  }
}
