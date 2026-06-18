import type { Phase } from '@ai-sdlc/domain';
import type { PhaseRepositoryPort } from '../ports/phase-repository-port.js';

export class FakePhaseRepository implements PhaseRepositoryPort {
  inserted: Phase[] = [];
  updated: Phase[] = [];

  insert(phase: Phase): void {
    this.inserted.push({ ...phase });
  }

  update(phase: Phase): void {
    this.updated.push({ ...phase });
  }

  findByRunUuid(runUuid: string): Phase[] {
    return this.inserted.filter((p) => p.runUuid === runUuid);
  }
}
