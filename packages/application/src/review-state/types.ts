export type ReviewMode = 'initial_full' | 'intermediate_delta' | 'final_full' | 'integration_full';
export type FindingDisposition = 'open' | 'addressed' | 'rebutted' | 'settled' | 'recurred';

export interface ReviewSnapshot {
  kind: 'git' | 'plan_artifact' | 'pr_comment';
  identity: string;
  baseIdentity?: string;
  capturedAt: string;
}

export interface ReviewFindingRecord {
  reviewerKind: string;
  severity: string;
  summary: string;
  path?: string;
  citation?: string;
  evidence?: string;
  fingerprint: string;
}

export interface DispositionHistoryEntry {
  disposition: FindingDisposition;
  changedAt: string;
  reason?: string;
}

export interface ReviewDimensionState {
  dimension: string;
  latestSnapshot?: ReviewSnapshot;
  latestVerdict?: string;
  dirty: boolean;
  provisionallyClean: boolean;
  unresolvedRecords: ReviewFindingRecord[];
  dispositionHistory: DispositionHistoryEntry[];
}

export interface ReviewAttempt {
  attemptId: string;
  runId: string;
  scope: string;
  step: string;
  reviewMode: ReviewMode;
  createdAt: string;
  artifacts: string[];
}

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
