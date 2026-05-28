export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'passed'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'needs_human_review';

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(['passed', 'failed', 'cancelled']);

export interface Run {
  uuid: string;
  displayId: string;
  issueNumber: number;
  type: 'issue_to_pr' | 'pr_review' | 'consolidate';
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
  type?: 'issue_to_pr' | 'pr_review' | 'consolidate';
}

export class RunStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunStateError';
  }
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
  if (run.currentPhase !== undefined) {
    throw new RunStateError(
      `cannot start phase '${phase}': run ${run.displayId} already has currentPhase '${run.currentPhase}' (call completePhase first)`,
    );
  }
  if (TERMINAL_STATUSES.has(run.status)) {
    throw new RunStateError(
      `cannot start phase '${phase}': run ${run.displayId} is already ${run.status}`,
    );
  }
  return { ...run, currentPhase: phase };
}

// `phase` must equal `currentPhase` — guards against callers who skipped a
// startPhase or passed the wrong name.
export function completePhase(run: Run, phase: string): Run {
  if (run.currentPhase === undefined) {
    throw new RunStateError(
      `cannot complete phase '${phase}': run ${run.displayId} has no currentPhase`,
    );
  }
  if (run.currentPhase !== phase) {
    throw new RunStateError(
      `cannot complete phase '${phase}': run ${run.displayId} is on '${run.currentPhase}'`,
    );
  }
  const { currentPhase, ...rest } = run;
  return { ...rest, completedPhases: [...run.completedPhases, currentPhase] };
}

export function passRun(run: Run, at: Date): Run {
  if (run.currentPhase !== undefined) {
    throw new RunStateError(
      `cannot pass run ${run.displayId}: currentPhase '${run.currentPhase}' is still set`,
    );
  }
  if (TERMINAL_STATUSES.has(run.status)) {
    throw new RunStateError(`cannot pass run ${run.displayId}: already ${run.status}`);
  }
  const next: Run = { ...run, status: 'passed', completedAt: at };
  delete next.currentPhase;
  return next;
}

export function failRun(run: Run, reason: string, at: Date = new Date()): Run {
  if (TERMINAL_STATUSES.has(run.status)) {
    throw new RunStateError(`cannot fail run ${run.displayId}: already ${run.status}`);
  }
  const next: Run = { ...run, status: 'failed', completedAt: at, failureReason: reason };
  delete next.currentPhase;
  return next;
}

export function cancelRun(run: Run, reason?: string, at: Date = new Date()): Run {
  if (TERMINAL_STATUSES.has(run.status)) {
    throw new RunStateError(`cannot cancel run ${run.displayId}: already ${run.status}`);
  }
  const next: Run = {
    ...run,
    status: 'cancelled',
    completedAt: at,
    ...(reason ? { failureReason: reason } : {}),
  };
  delete next.currentPhase;
  return next;
}

export function transitionToReady(run: Run): Run {
  if (run.currentPhase !== undefined) {
    throw new RunStateError(
      `cannot transition ${run.displayId} to ready: currentPhase '${run.currentPhase}' still set`,
    );
  }
  if (TERMINAL_STATUSES.has(run.status)) {
    throw new RunStateError(`cannot transition ${run.displayId} to ready: run is ${run.status}`);
  }
  if (run.status !== 'running') {
    throw new RunStateError(
      `cannot transition ${run.displayId} to ready: status is '${run.status}', expected 'running'`,
    );
  }
  return { ...run, status: 'waiting' };
}

export function reactivate(run: Run): Run {
  if (run.currentPhase !== undefined) {
    throw new RunStateError(
      `cannot reactivate ${run.displayId}: currentPhase '${run.currentPhase}' still set`,
    );
  }
  if (run.status !== 'waiting') {
    throw new RunStateError(
      `cannot reactivate ${run.displayId}: status is '${run.status}', expected 'waiting'`,
    );
  }
  return { ...run, status: 'running' };
}
