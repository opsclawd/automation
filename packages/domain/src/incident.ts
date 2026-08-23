export type IncidentType =
  | 'step.recovered_scope_violation'
  | 'step.premature_implementation'
  | 'step.task_boundary_blocked'
  | 'step.infrastructure_failure';

export interface IncidentPayload {
  runId: string;
  stepIndex: number;
  path: string;
  revertCount?: number;
  owningTaskIndex?: number;
}
