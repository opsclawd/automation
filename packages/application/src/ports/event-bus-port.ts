import type { OrchestratorEvent } from '@ai-sdlc/shared';

export interface EventBusPort {
  subscribe(runUuid: string, listener: (event: OrchestratorEvent) => void): () => void;
  publish(runUuid: string, event: OrchestratorEvent): void;
}
