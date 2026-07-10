import type { RunId, PhaseName, Loop } from '@ai-sdlc/domain';
import type { LoopRepositoryPort } from '../ports/loop-repository-port.js';
import type { EventBusPort } from '../ports/event-bus-port.js';
import type { StepAgentOutcome } from '../ports/agent-invocation-types.js';
import type { ArbiterResult } from '../implement-step/types.js';

export interface PlanReviewContext {
  loopId: string;
  runId: RunId;
  phaseId: PhaseName;
  repoId: string;
  cwd: string;
  iterationIndex: number; // 1-based
  metadata?: Record<string, unknown>;
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
  manifestMismatch?: string;
  metadata?: Record<string, unknown>;
}

export interface PlanReviewLoopOptions {
  /**
   * When true (default), grant exactly one additional fix iteration if the
   * trailing review arbiter rules `finding_valid`.
   */
  bonusIteration?: boolean;
}

export interface PlanReviewLoopDeps {
  runReview: (ctx: PlanReviewContext) => Promise<PlanReviewResult>;
  runFix: (ctx: PlanReviewContext, opts: PlanFixOptions) => Promise<PlanFixResult>;
  /**
   * Deterministic, no-LLM-call structural check that `plan.md`'s `## Task N`
   * prose headings agree with `task-manifest.json` — the same check
   * `implement`'s pre-flight gate runs. Returns a human-readable mismatch
   * description, or `null` when in sync (including when there is no
   * manifest to reconcile against).
   */
  checkManifestSync: (ctx: PlanReviewContext) => Promise<string | null>;
  runArbiter?: (ctx: PlanReviewContext, fixResult: PlanFixResult) => Promise<ArbiterResult>;
  /**
   * Distinct from `runArbiter`: invoked only for the trailing final-review-fail
   * path, which has no `PlanFixResult` (no fixer ran in that pass). Kept as a
   * separate field rather than an overload so there is no way to accidentally
   * pass a stale or synthesized fix result into it. Concretely, if these two
   * fields were collapsed (e.g. by giving `runArbiter` a `fixResult?` optional
   * parameter), a future maintainer could pass an empty `PlanFixResult`
   * synthesized from the trailing review's verdict, causing the arbiter to
   * rule on a fabricated fix result and silently override a real review
   * finding. The current shape makes that misuse unrepresentable.
   */
  runFinalReviewArbiter?: (
    ctx: PlanReviewContext,
    finalReview: PlanReviewResult,
  ) => Promise<ArbiterResult>;
  loops: LoopRepositoryPort;
  events: EventBusPort;
  /** Max reviewer retries on `agentOutcome !== 'success'` (parity #297). Default 2. */
  reviewerMaxRetries?: number;
  now: () => Date;
  idFactory: () => string;
  /** Convergence options. See `PlanReviewLoopOptions`. */
  options?: PlanReviewLoopOptions;
}

export interface PlanReviewLoopInput {
  runId: RunId;
  phaseId: PhaseName;
  repoId: string;
  cwd: string;
  maxIterations: number;
  /** Convergence options. Overrides any value on `Deps.options`. */
  options?: PlanReviewLoopOptions;
}

export interface PlanReviewLoopResult {
  loop: Loop;
  outcome: 'success' | 'failed' | 'needs_human_review';
  /** True when the loop converged with `verdict === 'proceed_with_concerns'`. */
  proceedWithConcerns: boolean;
  /** Carried-forward known limitations string (populated when proceedWithConcerns). */
  knownLimitations?: string;
}
