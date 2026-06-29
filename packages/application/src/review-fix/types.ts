import type { RunId, PhaseName, AgentProfileName, Loop } from '@ai-sdlc/domain';
import type { LoopRepositoryPort } from '../ports/loop-repository-port.js';
import type { EventBusPort } from '../ports/event-bus-port.js';
import type { StepAgentOutcome } from '../ports/agent-invocation-types.js';

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
  overridden?: boolean;
  offendingFindings?: Array<{ severity: string; summary: string }>;
  excerpt?: string;
}

export interface FixStepResult {
  invocationId: string;
  agentOutcome: StepAgentOutcome;
  verdict?: 'done_with_fixes' | 'done_no_fixes_needed' | 'cannot_fix';
  headBeforeFix?: string; // commit SHA before the fix, for rollback on revalidation failure
  summary?: string;
}

export interface RevalidationResult {
  validationRunId: string;
  passed: boolean;
  category?: string; // 'build' | 'lint' | 'typecheck' | 'test' | 'other'
}

export interface ArchitectPlanTask {
  task_id: string;
  approach: string;
  conflicts_resolved: string[];
  constraints: string[];
  depends_on: string[];
}

export interface ArchitectPlan {
  version: number;
  tasks: ArchitectPlanTask[];
}

export interface FixStepOptions {
  useFallback: boolean;
  previousInvocationId?: string;
  architectPlan?: ArchitectPlan;
  reconciliationContext?: string;
  historyContext?: string;
}

export interface PostFixGateResult {
  outcome: 'pass' | 'fail';
  output: string;
}

export interface ReviewFixLoopDeps {
  runPostFixGate: (ctx: StepContext) => Promise<PostFixGateResult>;
  runReview: (ctx: StepContext, opts?: ReviewStepOptions) => Promise<ReviewStepResult>;
  runFix: (ctx: StepContext, opts: FixStepOptions) => Promise<FixStepResult>;
  runRevalidation: (ctx: StepContext) => Promise<RevalidationResult>;
  loops: LoopRepositoryPort;
  events: EventBusPort;
  now: () => Date;
  idFactory: () => string;
  rollbackFix?: (ctx: StepContext, targetSha: string) => Promise<boolean>;
  cleanArtifacts?: (ctx: StepContext) => Promise<void>;
  loopHistory?: ReviewLoopHistoryPort;
}

export type ReviewLoopHistoryAudience = 'reviewer' | 'fixer';

export interface ReviewLoopHistoryEntry {
  iteration: number;
  review: {
    verdict?: 'pass' | 'fail';
    invocationId?: string;
    offendingFindings?: Array<{ severity: string; summary: string }>;
    excerpt?: string;
  };
  fix?: {
    verdict?: 'done_with_fixes' | 'done_no_fixes_needed' | 'cannot_fix';
    invocationId?: string;
    headBeforeFix?: string;
    summary?: string;
  };
  revalidation?: {
    passed: boolean;
    validationRunId?: string;
    category?: string;
  };
  outcome: 'resolved' | 'fixed' | 'unresolved' | 'failed';
}

export interface ReviewLoopHistoryPort {
  read(ctx: StepContext): Promise<ReviewLoopHistoryEntry[]>;
  append(ctx: StepContext, entry: ReviewLoopHistoryEntry): Promise<void>;
  format(history: ReviewLoopHistoryEntry[], audience: ReviewLoopHistoryAudience): string;
}

export interface ReviewStepOptions {
  gateResult?: PostFixGateResult;
  historyContext?: string;
}

export interface ReviewFixLoopInput {
  runId: RunId;
  phaseId: PhaseName;
  repoId: string;
  cwd: string;
  maxIterations: number;
  blockOnSeverity?: string;
  reviewProfile: AgentProfileName;
  fixProfile: AgentProfileName;
  fixFallbackProfile?: AgentProfileName;
  architectPlan?: ArchitectPlan;
}

export interface ReviewFixLoopResult {
  loop: Loop;
  phaseOutcome: 'passed' | 'failed';
}
