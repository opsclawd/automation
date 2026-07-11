import type { ReviewAttempt, ReviewDimensionState } from '../review-state/types.js';
import type { ReviewStateRepositoryPort } from '../ports/review-state-repository-port.js';

function cloneAttempt(a: ReviewAttempt): ReviewAttempt {
  return { ...a, artifacts: [...a.artifacts] };
}

function cloneState(s: ReviewDimensionState): ReviewDimensionState {
  return {
    ...s,
    unresolvedRecords: s.unresolvedRecords.map((r) => ({ ...r })),
    dispositionHistory: s.dispositionHistory.map((h) => ({ ...h })),
  };
}

type DimensionKey = string;

function dimensionKey(runId: string, scope: string, step: string, dimension: string): DimensionKey {
  return `${runId}|${scope}|${step}|${dimension}`;
}

export class FakeReviewStateRepository implements ReviewStateRepositoryPort {
  private readonly attempts: ReviewAttempt[] = [];
  private readonly dimensionStates = new Map<DimensionKey, ReviewDimensionState>();

  appendAttempt(attempt: ReviewAttempt): void {
    this.attempts.push(cloneAttempt(attempt));
  }

  listAttempts(runId: string, scope: string, step: string): ReviewAttempt[] {
    return this.attempts
      .filter((a) => a.runId === runId && a.scope === scope && a.step === step)
      .map(cloneAttempt)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  upsertDimensionState(
    runId: string,
    scope: string,
    step: string,
    state: ReviewDimensionState,
  ): void {
    const key = dimensionKey(runId, scope, step, state.dimension);
    this.dimensionStates.set(key, cloneState(state));
  }

  listDimensionStates(runId: string, scope: string, step: string): ReviewDimensionState[] {
    return [...this.dimensionStates.values()]
      .filter((s) =>
        dimensionKey(runId, scope, step, s.dimension).startsWith(`${runId}|${scope}|${step}|`),
      )
      .map(cloneState);
  }
}
