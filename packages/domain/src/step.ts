// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { RunId, PhaseName } from './ids.js';

export type StepStatus = 'pending' | 'running' | 'success' | 'failed';

export interface Step {
  id: string;
  /** Carries the RunId branded type at runtime; typed as string for Phase-pattern consistency. */
  runId: string;
  /** Carries the PhaseName branded type at runtime; typed as string for Phase-pattern consistency. */
  phaseId: string;
  index: number;
  title: string;
  status: StepStatus;
  startedAt?: Date;
  completedAt?: Date;
}
