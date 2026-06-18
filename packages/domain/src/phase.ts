export type PhaseStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'blocked'
  | 'resting';

export interface Phase {
  id: string;
  runUuid: string;
  name: string;
  status: PhaseStatus;
  attempt: number;
  startedAt?: Date;
  completedAt?: Date;
}
