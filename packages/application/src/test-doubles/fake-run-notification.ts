import type {
  RunNotificationPort,
  RunTerminalNotification,
} from '../ports/run-notification-port.js';

export class FakeRunNotification implements RunNotificationPort {
  public readonly events: RunTerminalNotification[] = [];
  public failWith?: Error;
  public synchronousError?: Error;

  notify(event: RunTerminalNotification): Promise<void> {
    if (this.synchronousError) {
      throw this.synchronousError;
    }
    if (this.failWith) {
      return Promise.reject(this.failWith);
    }
    this.events.push(event);
    return Promise.resolve();
  }

  public drainCalled = false;

  async drain(_timeoutMs?: number): Promise<void> {
    this.drainCalled = true;
  }
}
