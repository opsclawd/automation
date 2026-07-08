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
  typecheckErrors?: TypescriptError[] | string;
}

export interface TypescriptError {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
}

export interface TypecheckResult {
  outcome: 'pass' | 'fail';
  output: string;
  structuredErrors?: TypescriptError[];
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
  /** Commit SHA captured by the adapter before invoking the fix agent (#671). */
  headBeforeFix?: string;
}

/**
 * One entry appended per implement-step iteration that reached the fix stage.
 * Step-scoped: the port stores entries in a per-step file, so prior step
 * history never bleeds into the current step's fixer prompts (#671).
 */
export interface ImplementStepHistoryEntry {
  iteration: number;
  specReview: {
    verdict?: 'pass' | 'fail';
    invocationId?: string;
  };
  qualityReview: {
    verdict?: 'pass' | 'fail';
    invocationId?: string;
  };
  fix?: {
    verdict?: 'done_with_fixes' | 'done_no_fixes_needed' | 'cannot_fix';
    invocationId?: string;
    headBeforeFix?: string;
    summary?: string;
  };
  /**
   * When the iteration's top-of-iteration typecheck failed and the previous
   * fix was reverted, captures the typecheck errors that drove the revert.
   * Undefined for green iterations.
   */
  reverted?: {
    typecheckOutputPreview: string;
    typecheckErrorCount: number;
    headBeforeFix: string;
  };
  /** Always set; mirrors `iteration.outcome`. */
  outcome: 'resolved' | 'fixed' | 'unresolved' | 'failed';
}

/**
 * Step-scoped history port. Reads/append entries for the current step only;
 * format takes no audience argument — there is only one audience (the fixer).
 */
export interface ImplementStepHistoryPort {
  read(ctx: StepLoopContext): Promise<ImplementStepHistoryEntry[]>;
  append(ctx: StepLoopContext, entry: ImplementStepHistoryEntry): Promise<void>;
  format(history: ImplementStepHistoryEntry[]): string;
}

/**
 * Extends `FixStepOptions` with implement-step-only fields:
 * - `typecheckErrors`: post-fix typecheck errors, populated only on the
 *   iteration following a detected build-breaking regression. Routed into
 *   the fixer prompt via a `## TYPECHECK ERRORS (previous fix)` section.
 */
export interface ImplementFixStepOptions extends FixStepOptions {
  typecheckErrors?: string | TypescriptError[];
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
  runFix: (ctx: StepLoopContext, opts: ImplementFixStepOptions) => Promise<FixResult>;
  runArbiter?: (
    ctx: StepLoopContext,
    tcResult: TypecheckResult,
    fixResult: FixResult,
  ) => Promise<ArbiterResult>;
  loops: LoopRepositoryPort;
  events: EventBusPort;
  fixProfile: AgentProfileName;
  fixFallbackProfile?: AgentProfileName;
  /** History port for the current step (read/append/format for the fixer). */
  loopHistory?: ImplementStepHistoryPort;
  /**
   * Reverts a fix that turned a passing tree into a failing one.
   * Signature matches review-fix's `rollbackFix` — a `git reset --hard` is sufficient.
   * If absent, the loop falls back to `needs_human_review` on build-breaking fixes.
   */
  revertFix?: (ctx: StepLoopContext, targetSha: string) => Promise<boolean>;
  /**
   * Stall detection horizon: number of recent fingerprints compared against
   * the current one when deciding whether to escalate. Larger values catch
   * longer cyclic regressions but increase the time to detection. Defaults
   * to 2 in `ImplementStepLoop` when omitted.
   */
  stallHistorySize?: number;
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
