export type RecognizedCandidateKind = 'candidate_validation_report' | 'audit_closeout';

export type GovernanceFindingCode =
  | 'AFFIRMATIVE_DISPOSITION'
  | 'HUMAN_SIGN_OFF'
  | 'MEASURED_SCENARIO_CLAIM'
  | 'MEASURED_METRIC_CLAIM'
  | 'REAL_PROVIDER_CLAIM'
  | 'CANDIDATE_SHA_BINDING'
  | 'DUPLICATE_JSON_KEY'
  | 'DELETED_RECOGNIZED_ARTIFACT';

export interface GovernanceFinding {
  code: GovernanceFindingCode;
  severity: 'critical';
  message: string;
  path: string;
  line?: number;
  rawMatch?: string;
}

export type FileReadState =
  | { state: 'present'; content: string; contentHash: string }
  | { state: 'absent' };

export type CandidateSnapshot = Map<string, FileReadState>;
