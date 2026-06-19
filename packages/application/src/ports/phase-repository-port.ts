import type { Phase } from '@ai-sdlc/domain';

export interface PhaseRepositoryPort {
  insert(phase: Phase): void;
  update(phase: Phase): void;
}
