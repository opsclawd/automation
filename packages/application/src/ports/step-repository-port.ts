import type { RunId, PhaseName, Step } from '@ai-sdlc/domain';

export interface StepRepositoryPort {
  /** Insert-or-update a step, keyed by (runId, phaseId, index). */
  upsert(step: Step): void;
  /** List all steps for a run, sorted by (phaseId, index). */
  listForRun(runId: RunId): Step[];
  /** Find a step by its composite key (runId, phaseId, index). */
  findByIndex(runId: RunId, phaseId: PhaseName, index: number): Step | undefined;
}
