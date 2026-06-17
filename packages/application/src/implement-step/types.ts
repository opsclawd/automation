import type { RunId, PhaseName, AgentProfileName, Loop } from '@ai-sdlc/domain';
import type { LoopRepositoryPort } from '../ports/loop-repository-port.js';
import type { EventBusPort } from '../ports/event-bus-port.js';

export type StepAgentOutcome = 'success' | 'failed' | 'timeout' | 'contract_violation';

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
}

export interface FixStepOptions {
  useFallback: boolean;
  previousInvocationId?: string;
}

export interface ImplementStepLoopDeps {
  runImplement: (ctx: StepLoopContext) => Promise<ImplementResult>;
  runSpecReview: (ctx: StepLoopContext) => Promise<SpecReviewResult>;
  runQualityReview: (ctx: StepLoopContext) => Promise<QualityReviewResult>;
  runFix: (ctx: StepLoopContext, opts: FixStepOptions) => Promise<FixResult>;
  loops: LoopRepositoryPort;
  events: EventBusPort;
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
  implementProfile: AgentProfileName;
  specReviewProfile: AgentProfileName;
  qualityReviewProfile: AgentProfileName;
  fixProfile: AgentProfileName;
  fixFallbackProfile?: AgentProfileName;
}

export interface ImplementStepLoopResult {
  loop: Loop;
  outcome: 'success' | 'failed';
}
