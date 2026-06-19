import type { PhaseName } from '@ai-sdlc/domain';
import type { PhaseHandler } from '../phases/handler.js';
import type { PhaseHandlerRegistryPort } from '../ports/phase-handler-registry-port.js';

export class PhaseHandlerRegistry implements PhaseHandlerRegistryPort {
  private readonly handlers = new Map<PhaseName, PhaseHandler>();

  register(handler: PhaseHandler): void {
    this.handlers.set(handler.phase, handler);
  }

  get(phase: PhaseName): PhaseHandler {
    const handler = this.handlers.get(phase);
    if (!handler) throw new UnregisteredPhaseError(phase);
    return handler;
  }
}

export class UnregisteredPhaseError extends Error {
  constructor(phase: PhaseName) {
    super(`no PhaseHandler registered for '${String(phase)}'`);
    this.name = 'UnregisteredPhaseError';
  }
}
