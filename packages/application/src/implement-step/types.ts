import type { RunId, PhaseName, AgentProfileName, Loop } from '@ai-sdlc/domain';
import type { LoopRepositoryPort } from '../ports/loop-repository-port.js';
import type { EventBusPort } from '../ports/event-bus-port.js';
import type { StepAgentOutcome } from '../ports/agent-invocation-types.js';
import type { FixStepOptions } from '../review-fix/types.js';

export interface StepLoopContext {
  loopId: string;
  runId: RunId;
  phaseId: PhaseName;
  repoId: string;
  cwd: string;
  stepIndex: number;
  stepTitle: string;
  iterationIndex: number; // 1-based
}

export interface ImplementResult {
  invocationId: string;
  agentOutcome: StepAgentOutcome;
}

export interface ImplementStepOptions {
  typecheckErrors?: string;
}

export interface TypecheckResult {
  outcome: 'pass' | 'fail';
  output: string;
}

export interface SpecReviewResult {
  invocationId: string;
  agentOutcome: StepAgentOutcome;
  verdict?: 'pass' | 'fail';
}

export interface QualityReviewResult {
  invocationId: string;
  agentOutcome: StepAgentOutcome;
  verdict?: 'pass' | 'fail';
}

export interface FixResult {
  invocationId: string;
  agentOutcome: StepAgentOutcome;
  verdict?: 'done_with_fixes' | 'done_no_fixes_needed' | 'cannot_fix';
  rebuttal?: string;
}

export interface ArbiterResult {
  outcome: 'finding_valid' | 'finding_invalid' | 'ambiguous' | 'insufficient_evidence';
  defect_classification?: string;
  evidence: string;
  rationale: string;
}

export interface ImplementStepLoopDeps {
  runImplement: (ctx: StepLoopContext, opts?: ImplementStepOptions) => Promise<ImplementResult>;
  runTypecheck: (ctx: StepLoopContext) => Promise<TypecheckResult>;
  runSpecReview: (ctx: StepLoopContext, tcResult: TypecheckResult) => Promise<SpecReviewResult>;
  runQualityReview: (
    ctx: StepLoopContext,
    tcResult: TypecheckResult,
  ) => Promise<QualityReviewResult>;
  runFix: (ctx: StepLoopContext, opts: FixStepOptions) => Promise<FixResult>;
  runArbiter?: (
    ctx: StepLoopContext,
    tcResult: TypecheckResult,
    fixResult: FixResult,
  ) => Promise<ArbiterResult>;
  loops: LoopRepositoryPort;
  events: EventBusPort;
  fixProfile: AgentProfileName;
  fixFallbackProfile?: AgentProfileName;
  now: () => Date;
  idFactory: () => string;
}

export interface ImplementStepLoopInput {
  runId: RunId;
  phaseId: PhaseName;
  repoId: string;
  cwd: string;
  stepIndex: number;
  stepTitle: string;
  maxIterations: number;
  maxTypeCheckRetries?: number;
}

export interface ImplementStepLoopResult {
  loop: Loop;
  outcome: 'success' | 'failed' | 'needs_human_review';
}
