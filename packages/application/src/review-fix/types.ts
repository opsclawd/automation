import type { RunId, PhaseName, AgentProfileName, Loop } from '@ai-sdlc/domain';
import type { LoopRepositoryPort } from '../ports/loop-repository-port.js';
import type { EventBusPort } from '../ports/event-bus-port.js';

export type StepAgentOutcome = 'success' | 'failed' | 'timeout' | 'contract_violation';

export interface StepContext {
  loopId: string;
  runId: RunId;
  phaseId: PhaseName;
  repoId: string;
  cwd: string;
  iterationIndex: number; // 1-based
}

export interface ReviewStepResult {
  invocationId: string;
  agentOutcome: StepAgentOutcome;
  verdict?: 'pass' | 'fail';
}

export interface FixStepResult {
  invocationId: string;
  agentOutcome: StepAgentOutcome;
  verdict?: 'done_with_fixes' | 'done_no_fixes_needed' | 'cannot_fix';
}

export interface RevalidationResult {
  validationRunId: string;
  passed: boolean;
  category?: string; // 'build' | 'lint' | 'typecheck' | 'test' | 'other'
}

export interface FixStepOptions {
  useFallback: boolean;
  previousInvocationId?: string;
}

export interface ReviewFixLoopDeps {
  runReview: (ctx: StepContext) => Promise<ReviewStepResult>;
  runFix: (ctx: StepContext, opts: FixStepOptions) => Promise<FixStepResult>;
  runRevalidation: (ctx: StepContext) => Promise<RevalidationResult>;
  loops: LoopRepositoryPort;
  events: EventBusPort;
  now: () => Date;
  idFactory: () => string;
}

export interface ReviewFixLoopInput {
  runId: RunId;
  phaseId: PhaseName;
  repoId: string;
  cwd: string;
  maxIterations: number;
  reviewProfile: AgentProfileName;
  fixProfile: AgentProfileName;
  fixFallbackProfile?: AgentProfileName;
}

export interface ReviewFixLoopResult {
  loop: Loop;
  phaseOutcome: 'passed' | 'failed';
}
