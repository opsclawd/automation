import type { PhaseName } from '@ai-sdlc/domain';
import type { PhaseHandler } from '../phases/handler.js';

export interface PhaseHandlerRegistryPort {
  register(handler: PhaseHandler): void;
  get(phase: PhaseName): PhaseHandler;
}
