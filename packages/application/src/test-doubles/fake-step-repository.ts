import type { RunId, PhaseName, Step } from '@ai-sdlc/domain';
import type { StepRepositoryPort } from '../ports/step-repository-port.js';

export class FakeStepRepository implements StepRepositoryPort {
  private readonly store = new Map<string, Step>();

  private key(runId: string, phaseId: string, index: number): string {
    return `${runId}:${phaseId}:${index}`;
  }

  upsert(step: Step): void {
    this.store.set(this.key(step.runId, step.phaseId, step.index), { ...step });
  }

  listForRun(runId: RunId): Step[] {
    return [...this.store.values()]
      .filter((s) => s.runId === runId)
      .sort((a, b) => {
        const pa = String(a.phaseId);
        const pb = String(b.phaseId);
        if (pa < pb) return -1;
        if (pa > pb) return 1;
        return a.index - b.index;
      })
      .map((s) => ({ ...s }));
  }

  findByIndex(runId: RunId, phaseId: PhaseName, index: number): Step | undefined {
    const found = this.store.get(this.key(runId, String(phaseId), index));
    return found ? { ...found } : undefined;
  }
}
