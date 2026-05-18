import { EventEmitter } from 'node:events';
import type { OrchestratorEvent } from '@ai-sdlc/shared';

export type EventListener = (event: OrchestratorEvent) => void;
export type Unsubscribe = () => void;

export class InMemoryEventBus {
  private readonly emitters = new Map<string, EventEmitter>();

  subscribe(runUuid: string, listener: EventListener): Unsubscribe {
    let emitter = this.emitters.get(runUuid);
    if (!emitter) {
      emitter = new EventEmitter();
      emitter.setMaxListeners(0);
      this.emitters.set(runUuid, emitter);
    }
    emitter.on('event', listener);
    return () => {
      emitter!.off('event', listener);
      if (emitter!.listenerCount('event') === 0) {
        this.emitters.delete(runUuid);
      }
    };
  }

  publish(runUuid: string, event: OrchestratorEvent): void {
    const emitter = this.emitters.get(runUuid);
    if (emitter) emitter.emit('event', event);
  }
}
