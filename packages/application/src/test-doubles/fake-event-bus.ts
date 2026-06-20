import type { EventBusPort } from '../ports/event-bus-port.js';
import type { OrchestratorEvent } from '@ai-sdlc/shared';

export class FakeEventBus implements EventBusPort {
  published: Array<{ runUuid: string; type: string }> = [];

  subscribe(): () => void {
    return () => {};
  }

  publish(runUuid: string, event: OrchestratorEvent): void {
    this.published.push({ runUuid, type: event.type });
  }
}
