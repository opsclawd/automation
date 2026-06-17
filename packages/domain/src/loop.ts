import type { RunId, PhaseName } from './ids.js';

export type LoopType = 'review-fix' | 'implement-step';

export type LoopStatus = 'running' | 'converged' | 'exhausted' | 'failed';

export type LoopIterationOutcome = 'resolved' | 'fixed' | 'unresolved' | 'failed';

export interface LoopIteration {
  index: number;
  reviewInvocationId: string;
  qualityReviewInvocationId?: string;
  fixInvocationId?: string;
  revalidationId?: string;
  outcome?: LoopIterationOutcome;
  startedAt: Date;
  completedAt?: Date;
}

export interface Loop {
  id: string;
  runId: RunId;
  phaseId: PhaseName;
  type: LoopType;
  maxIterations: number;
  iterations: LoopIteration[];
  status: LoopStatus;
  startedAt: Date;
  completedAt?: Date;
}

export class LoopStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoopStateError';
    Object.setPrototypeOf(this, LoopStateError.prototype);
  }
}

export interface CreateLoopInput {
  id: string;
  runId: RunId;
  phaseId: PhaseName;
  type: LoopType;
  maxIterations: number;
  now: Date;
}

export function createLoop(input: CreateLoopInput): Loop {
  if (!Number.isInteger(input.maxIterations) || input.maxIterations < 1) {
    throw new LoopStateError(
      `maxIterations must be a positive integer, got ${input.maxIterations}`,
    );
  }
  return {
    id: input.id,
    runId: input.runId,
    phaseId: input.phaseId,
    type: input.type,
    maxIterations: input.maxIterations,
    iterations: [],
    status: 'running',
    startedAt: input.now,
  };
}

export function canIterate(loop: Loop): boolean {
  return loop.status === 'running' && loop.iterations.length < loop.maxIterations;
}

function openIteration(loop: Loop): LoopIteration | undefined {
  const last = loop.iterations[loop.iterations.length - 1];
  return last && last.completedAt === undefined ? last : undefined;
}

export function startIteration(loop: Loop, input: { reviewInvocationId: string; now: Date }): Loop {
  if (loop.status !== 'running') {
    throw new LoopStateError(`cannot start iteration: loop ${loop.id} is ${loop.status}`);
  }
  if (openIteration(loop)) {
    throw new LoopStateError(`cannot start iteration: loop ${loop.id} has an open iteration`);
  }
  if (loop.iterations.length >= loop.maxIterations) {
    throw new LoopStateError(
      `cannot start iteration: loop ${loop.id} reached maxIterations (${loop.maxIterations})`,
    );
  }
  const iteration: LoopIteration = {
    index: loop.iterations.length + 1,
    reviewInvocationId: input.reviewInvocationId,
    startedAt: input.now,
  };
  return { ...loop, iterations: [...loop.iterations, iteration] };
}

export function completeIteration(
  loop: Loop,
  input: {
    outcome: LoopIterationOutcome;
    fixInvocationId?: string;
    revalidationId?: string;
    now: Date;
  },
): Loop {
  const open = openIteration(loop);
  if (!open) {
    throw new LoopStateError(`cannot complete iteration: loop ${loop.id} has no open iteration`);
  }
  const updated: LoopIteration = {
    ...open,
    outcome: input.outcome,
    completedAt: input.now,
    ...(input.fixInvocationId !== undefined ? { fixInvocationId: input.fixInvocationId } : {}),
    ...(input.revalidationId !== undefined ? { revalidationId: input.revalidationId } : {}),
  };
  const iterations = [...loop.iterations.slice(0, -1), updated];

  let status: LoopStatus = 'running';
  if (input.outcome === 'resolved') status = 'converged';
  else if (input.outcome === 'failed') status = 'failed';

  return {
    ...loop,
    iterations,
    status,
    ...(status !== 'running' ? { completedAt: input.now } : {}),
  };
}

export function updateOpenIteration(
  loop: Loop,
  input: { qualityReviewInvocationId: string },
): Loop {
  const open = openIteration(loop);
  if (!open) {
    throw new LoopStateError(`cannot update: loop ${loop.id} has no open iteration`);
  }
  const updated: LoopIteration = {
    ...open,
    qualityReviewInvocationId: input.qualityReviewInvocationId,
  };
  return { ...loop, iterations: [...loop.iterations.slice(0, -1), updated] };
}

export function exhaust(loop: Loop, now: Date): Loop {
  if (loop.status !== 'running') {
    throw new LoopStateError(`cannot exhaust loop ${loop.id}: already ${loop.status}`);
  }
  return { ...loop, status: 'exhausted', completedAt: now };
}
