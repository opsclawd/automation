import type { RunNotificationPort, RunTerminalNotification } from '@ai-sdlc/application/ports';

export class NoopRunNotificationAdapter implements RunNotificationPort {
  async notify(_event: RunTerminalNotification): Promise<void> {}
  async drain(_timeoutMs?: number): Promise<void> {}
}
