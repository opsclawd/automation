export interface LoopIterationDto {
  index: number;
  outcome: 'resolved' | 'fixed' | 'unresolved' | 'failed' | null;
  reviewInvocationId: string;
  qualityReviewInvocationId: string | null;
  fixInvocationId: string | null;
  revalidationId: string | null;
  reviewArtifactPath: string;
  fixArtifactPath: string | null;
  revalidateArtifactPath: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface LoopDto {
  id: string;
  phaseId: string;
  type: 'review-fix' | 'implement-step';
  status: 'running' | 'converged' | 'converged_with_notes' | 'exhausted' | 'failed';
  maxIterations: number;
  startedAt: string;
  completedAt: string | null;
  iterations: LoopIterationDto[];
}

export type PillColor = 'green' | 'red' | 'blue' | 'amber' | 'slate';

const BADGE: Record<LoopDto['status'], { label: string; color: PillColor }> = {
  running: { label: 'Running', color: 'blue' },
  converged: { label: 'Converged', color: 'green' },
  converged_with_notes: { label: 'Converged (Notes)', color: 'amber' },
  exhausted: { label: 'Exhausted', color: 'red' },
  failed: { label: 'Failed', color: 'red' },
};

export function loopBadge(status: LoopDto['status']): { label: string; color: PillColor } {
  return BADGE[status];
}

const CHIP: Record<
  NonNullable<LoopIterationDto['outcome']>,
  { label: string; color: PillColor }
> = {
  resolved: { label: 'resolved', color: 'green' },
  fixed: { label: 'fixed', color: 'blue' },
  unresolved: { label: 'unresolved', color: 'amber' },
  failed: { label: 'failed', color: 'red' },
};

export function iterationChip(outcome: LoopIterationDto['outcome']): {
  label: string;
  color: PillColor;
} {
  return outcome === null ? { label: 'running', color: 'slate' } : CHIP[outcome];
}

export const PILL_CLASS: Record<PillColor, string> = {
  green: 'bg-green-100 text-green-800',
  red: 'bg-red-100 text-red-800',
  blue: 'bg-blue-100 text-blue-800',
  amber: 'bg-amber-100 text-amber-800',
  slate: 'bg-slate-100 text-slate-600',
};
