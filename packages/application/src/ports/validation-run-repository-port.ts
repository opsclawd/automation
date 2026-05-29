import type { RunId, ValidationRun } from '@ai-sdlc/domain';

export interface ValidationRunRepositoryPort {
  save(run: ValidationRun): void;
  findById(id: string): ValidationRun | null;
  listByRun(runId: RunId): ValidationRun[];
}
