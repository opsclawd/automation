import type { ReviewAttempt, ReviewDimensionState } from '../review-state/types.js';

export interface ReviewStateRepositoryPort {
  appendAttempt(attempt: ReviewAttempt): void;
  listAttempts(runId: string, scope: string, step: string): ReviewAttempt[];
  upsertDimensionState(
    runId: string,
    scope: string,
    step: string,
    state: ReviewDimensionState,
  ): void;
  listDimensionStates(runId: string, scope: string, step: string): ReviewDimensionState[];
}
