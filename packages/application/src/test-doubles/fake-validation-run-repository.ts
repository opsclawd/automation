import type { RunId, ValidationRun } from '@ai-sdlc/domain';
import type { ValidationRunRepositoryPort } from '../ports/validation-run-repository-port.js';

export class FakeValidationRunRepository implements ValidationRunRepositoryPort {
  private byId = new Map<string, ValidationRun>();

  save(run: ValidationRun): void {
    this.byId.set(run.id, run);
  }

  findById(id: string): ValidationRun | null {
    return this.byId.get(id) ?? null;
  }

  listByRun(runId: RunId): ValidationRun[] {
    return [...this.byId.values()].filter((v) => v.runId === runId);
  }
}
