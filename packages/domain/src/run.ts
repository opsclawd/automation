export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'passed'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'needs_human_review';

export interface Run {
  uuid: string;
  displayId: string;
  issueNumber: number;
  type: 'issue_to_pr' | 'pr_review';
  status: RunStatus;
  currentPhase?: string;
  completedPhases: string[];
  startedAt: Date;
  completedAt?: Date;
  failureReason?: string;
}

export interface CreateRunInput {
  uuid: string;
  displayId: string;
  issueNumber: number;
  startedAt: Date;
  type?: 'issue_to_pr' | 'pr_review';
}

export function createRun(input: CreateRunInput): Run {
  return {
    uuid: input.uuid,
    displayId: input.displayId,
    issueNumber: input.issueNumber,
    type: input.type ?? 'issue_to_pr',
    status: 'running',
    completedPhases: [],
    startedAt: input.startedAt,
  };
}

export function startPhase(run: Run, phase: string): Run {
  return { ...run, currentPhase: phase };
}

export function completePhase(run: Run, phase: string): Run {
  const { currentPhase: _currentPhase, ...rest } = run;
  void _currentPhase;
  return { ...rest, completedPhases: [...run.completedPhases, phase] };
}

export function passRun(run: Run, at: Date): Run {
  const { currentPhase: _currentPhase, ...rest } = run;
  void _currentPhase;
  return { ...rest, status: 'passed', completedAt: at };
}

export function failRun(run: Run, reason: string, at: Date = new Date()): Run {
  return { ...run, status: 'failed', completedAt: at, failureReason: reason };
}
