export type FailureKind =
  | 'command_failed'
  | 'timeout'
  | 'missing_artifact'
  | 'invalid_result'
  | 'agent_blocked'
  | 'agent_incomplete'
  | 'agent_contract_violation'
  | 'branch_changed'
  | 'validation_failed'
  | 'github_failed'
  | 'git_failed'
  | 'polling_failed'
  | 'handler_not_wired'
  | 'setup_failed'
  | 'unknown';

export interface Failure {
  runUuid: string;
  phase?: string;
  step?: string;
  attempt?: number;
  kind: FailureKind;
  message: string;
  exitCode?: number;
  canRetry: boolean;
  suggestedAction: string;
  artifacts: string[];
  detectedAt: Date;
}
