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
  /** Commit at HEAD immediately before this Step's first declared-file attempt. */
  initialPreStepHead?: string;
  /** Per-file revert count map. */
  revertCounts: Record<string, number>;
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
    revertCounts: {},
  };
}

export function normalizeTaskPath(path: unknown): string {
  if (typeof path !== 'string') return '';
  const trimmed = path.trim();
  if (!trimmed) return '';
  const posixPath = trimmed.replace(/\\/g, '/');
  const segments = posixPath.split('/');
  const stack: string[] = [];
  for (const seg of segments) {
    if (!seg || seg === '.') {
      continue;
    }
    if (seg === '..') {
      stack.pop();
    } else {
      stack.push(seg);
    }
  }
  return stack.join('/');
}
