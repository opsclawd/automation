export type PhaseStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'blocked'
  | 'resting'
  | 'needs_human_review'
  | 'deferred';

export interface Phase {
  id: string;
  runUuid: string;
  name: string;
  status: PhaseStatus;
  attempt: number;
  startedAt?: Date;
  completedAt?: Date;
}
