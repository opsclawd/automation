import type { RunId, PhaseName, Step } from '@ai-sdlc/domain';

export interface StepRepositoryPort {
  upsert(step: Step): void;
  listForRun(runId: RunId): Step[];
  findByIndex(runId: RunId, phaseId: PhaseName, index: number): Step | undefined;
}
