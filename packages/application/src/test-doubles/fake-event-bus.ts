import type { EventBusPort } from '../ports/event-bus-port.js';
import type { OrchestratorEvent } from '@ai-sdlc/shared';

export class FakeEventBus implements EventBusPort {
  published: Array<{ runUuid: string; event: OrchestratorEvent }> = [];
  private listeners = new Map<string, Set<(event: OrchestratorEvent) => void>>();

  subscribe(runUuid: string, listener: (event: OrchestratorEvent) => void): () => void {
    if (!this.listeners.has(runUuid)) this.listeners.set(runUuid, new Set());
    this.listeners.get(runUuid)!.add(listener);
    return () => this.listeners.get(runUuid)?.delete(listener);
  }

  publish(runUuid: string, event: OrchestratorEvent): void {
    this.published.push({ runUuid, event });
    this.listeners.get(runUuid)?.forEach((fn) => fn(event));
  }
}
