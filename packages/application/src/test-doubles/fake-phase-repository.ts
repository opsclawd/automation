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

  listByRun(runUuid: string): Phase[] {
    const merged = new Map<string, Phase>();
    for (const p of this.inserted) merged.set(p.id, { ...p });
    for (const p of this.updated) merged.set(p.id, { ...p });
    return [...merged.values()].filter((p) => p.runUuid === runUuid);
  }
}
