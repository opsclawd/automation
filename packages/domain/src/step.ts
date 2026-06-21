import type { RunId, PhaseName } from './ids.js';

export type StepStatus = 'pending' | 'running' | 'success' | 'failed' | 'needs_human_review';

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

export interface CreateStepInput {
  id: string;
  runId: RunId;
  phaseId: PhaseName;
  index: number;
  title: string;
}

export function createStep(input: CreateStepInput): Step {
  return {
    id: input.id,
    runId: input.runId,
    phaseId: input.phaseId,
    index: input.index,
    title: input.title,
    status: 'pending',
  };
}
