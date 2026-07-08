import type { RunId, PhaseName } from '@ai-sdlc/domain';
import type { LoopRepositoryPort } from '../ports/loop-repository-port.js';
import type { EventBusPort } from '../ports/event-bus-port.js';
import type { StepAgentOutcome } from '../ports/agent-invocation-types.js';
export type { ArbiterResult } from '../implement-step/types.js';

export interface PlanReviewContext {
  loopId: string;
  runId: RunId;
  phaseId: PhaseName;
  repoId: string;
  cwd: string;
  iterationIndex: number; // 1-based
}

export interface PlanReviewResult {
  invocationId: string;
  agentOutcome: StepAgentOutcome;
  verdict?: 'pass' | 'p1_found' | 'p2_only' | 'proceed_with_concerns';
  /** Free-text summary of findings, surfaced for the handler's append-to-plan path. */
  knownLimitations?: string;
}

export interface PlanFixResult {
  invocationId: string;
  agentOutcome: StepAgentOutcome;
  verdict?: 'done_with_fixes' | 'done_no_fixes_needed' | 'cannot_fix';
  rebuttal?: string;
  summary?: string;
}

export interface PlanFixOptions {
  historyContext?: string;
  reconciliationContext?: string;
}

export interface PlanReviewLoopDeps {
  runReview: (ctx: PlanReviewContext) => Promise<PlanReviewResult>;
  runFix: (ctx: PlanReviewContext, opts: PlanFixOptions) => Promise<PlanFixResult>;
  runArbiter?: (
    ctx: PlanReviewContext,
    fixResult: PlanFixResult,
  ) => Promise<import('../implement-step/types.js').ArbiterResult>;
  loops: LoopRepositoryPort;
  events: EventBusPort;
  /** Max reviewer retries on `agentOutcome !== 'success'` (parity #297). Default 2. */
  reviewerMaxRetries?: number;
  now: () => Date;
  idFactory: () => string;
}

export interface PlanReviewLoopInput {
  runId: RunId;
  phaseId: PhaseName;
  repoId: string;
  cwd: string;
  maxIterations: number;
}

export interface PlanReviewLoopResult {
  loop: import('@ai-sdlc/domain').Loop;
  outcome: 'success' | 'failed' | 'needs_human_review';
  /** True when the loop converged with `verdict === 'proceed_with_concerns'`. */
  proceedWithConcerns: boolean;
  /** Carried-forward known limitations string (populated when proceedWithConcerns). */
  knownLimitations?: string;
}
