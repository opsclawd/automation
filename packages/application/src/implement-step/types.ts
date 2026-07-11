import type { RunId, PhaseName, AgentProfileName, Loop } from '@ai-sdlc/domain';
import type { TaskManifest } from '../results/schemas/task-manifest.js';
import type { LoopRepositoryPort } from '../ports/loop-repository-port.js';
import type { EventBusPort } from '../ports/event-bus-port.js';
import type { StepAgentOutcome } from '../ports/agent-invocation-types.js';
import type { FixStepOptions } from '../review-fix/types.js';
import type { GitPort } from '../ports/git-port.js';

export interface StepLoopContext {
  loopId: string;
  runId: RunId;
  phaseId: PhaseName;
  repoId: string;
  cwd: string;
  stepIndex: number;
  stepTitle: string;
  iterationIndex: number; // 1-based
  /** Invocation-metadata tagging (#719): invocation type, task/comment linkage, etc. */
  metadata?: Record<string, unknown>;
  manifest: TaskManifest;
  planMd: string;
}

export interface ImplementResult {
  invocationId: string;
  agentOutcome: StepAgentOutcome;
}

export interface ImplementStepOptions {
  typecheckErrors?: TypescriptError[] | string;
  useFallback?: boolean;
  previousInvocationId?: string;
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

export type ReviewMode = 'initial_full' | 'intermediate_delta' | 'final_full';

export type DimensionName = 'spec' | 'quality';

export type DimensionState = 'clean' | 'dirty' | 'recurred';

export interface ReviewFindings {
  findings: unknown[];
}

export interface ReviewSnapshot {
  snapshot: string;
}

export interface ReviewScopeOptions {
  mode: ReviewMode;
  dimensions?: DimensionName[];
}

export interface SpecReviewResult {
  invocationId: string;
  agentOutcome: StepAgentOutcome;
  verdict?: 'pass' | 'fail';
  findings?: ReviewFindings;
  snapshot?: ReviewSnapshot;
  mode?: ReviewMode;
}

export interface QualityReviewResult {
  invocationId: string;
  agentOutcome: StepAgentOutcome;
  verdict?: 'pass' | 'fail';
  findings?: ReviewFindings;
  snapshot?: ReviewSnapshot;
  mode?: ReviewMode;
}

export interface FixResult {
  invocationId: string;
  agentOutcome: StepAgentOutcome;
  verdict?: 'done_with_fixes' | 'done_no_fixes_needed' | 'cannot_fix';
  rebuttal?: string;
  /** Commit SHA captured by the adapter before invoking the fix agent (#671). */
  headBeforeFix?: string;
  summary?: string;
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
  /**
   * When `done_with_fixes` was claimed but HEAD did not advance and the
   * worktree is dirty (e.g. a pre-commit hook rejected the commit), the
   * verifier populates this block. Undefined for genuine committed fixes
   * and for non-done_with_fixes verdicts.
   */
  uncommittedChanges?: { dirtyFiles: string[]; statusOutput: string };
  /**
   * When `done_with_fixes` was claimed but HEAD did not advance and the
   * worktree is clean, the verifier populates this block. Undefined for
   * genuine committed fixes and for non-done_with_fixes verdicts.
   */
  noCommit?: { statusOutput: string };
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

/**
 * Convergence-on-large-diffs options (#680). Mirrors `ReviewFixLoopOptions.endOnReview`:
 * when true, the budget grants one trailing re-review whenever the last allowed
 * iteration ended with `outcome: 'fixed'`. The trailing re-review does NOT
 * count against `maxIterations` (the loop bumps `loop.maxIterations` to
 * `originalMax + 1` for the trailing pass only).
 *
 * Set `endOnReview: false` to restore pre-#680 behavior bit-for-bit (the
 * loop exhausts immediately when `canIterate` returns false, with no
 * trailing pass).
 */
export interface ImplementStepLoopOptions {
  /**
   * When true (default), grant a trailing re-review pass at the cap if
   * the cap iteration ended `fixed`. The trailing pass runs the
   * top-of-iteration typecheck and the spec/quality reviews only;
   * `runFix` is not invoked.
   */
  endOnReview?: boolean;
  /**
   * When true (default), grant exactly one additional fix iteration if the
   * trailing review arbiter rules `finding_valid`.
   */
  bonusIteration?: boolean;
}

export interface ReviewState {
  dirtyDimensions: Record<DimensionName, DimensionState>;
  finalPairCandidateHead: string | undefined;
  finalPairSnapshots: { spec: string | undefined; quality: string | undefined };
}

export interface ImplementStepLoopDeps {
  runImplement: (ctx: StepLoopContext, opts?: ImplementStepOptions) => Promise<ImplementResult>;
  runTypecheck: (ctx: StepLoopContext) => Promise<TypecheckResult>;
  runSpecReview: (
    ctx: StepLoopContext,
    tcResult: TypecheckResult,
    scope: ReviewScopeOptions,
  ) => Promise<SpecReviewResult>;
  runQualityReview: (
    ctx: StepLoopContext,
    tcResult: TypecheckResult,
    scope: ReviewScopeOptions,
  ) => Promise<QualityReviewResult>;
  runFix: (ctx: StepLoopContext, opts: ImplementFixStepOptions) => Promise<FixResult>;
  implementProfile: AgentProfileName;
  implementFallbackProfile?: AgentProfileName;
  runArbiter?: (
    ctx: StepLoopContext,
    tcResult: TypecheckResult,
    fixResult: FixResult,
  ) => Promise<ArbiterResult>;
  /**
   * Escalates a failing trailing re-review pass (#680) to an arbiter before
   * the loop exhausts to failure. Distinct from `runArbiter` (which requires
   * a `FixResult`) because no fixer runs on the trailing pass — if these two
   * fields were collapsed, a future maintainer could pass an empty `FixResult`
   * synthesized from the trailing review's verdict, lying to the arbiter that
   * a fixer evaluated the finding when none did. Optional: when omitted,
   * a trailing-pass fail exhausts exactly as it did before this dep existed (#690).
   */
  runFinalReviewArbiter?: (
    ctx: StepLoopContext,
    tcResult: TypecheckResult,
    specReview: SpecReviewResult,
    qualityReview: QualityReviewResult,
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
   * Used by the fix-commit verifier (#679). When absent, the loop does not
   * downgrade `done_with_fixes` iterations — the verifier is intentionally
   * optional so test doubles can omit it.
   */
  git?: GitPort;
  /**
   * Stall detection horizon: number of recent fingerprints compared against
   * the current one when deciding whether to escalate. Larger values catch
   * longer cyclic regressions but increase the time to detection. Defaults
   * to 2 in `ImplementStepLoop` when omitted.
   */
  stallHistorySize?: number;
  now: () => Date;
  idFactory: () => string;
  /**
   * Convergence options (#680). See `ImplementStepLoopOptions`. If
   * omitted, defaults to `{ endOnReview: true }`.
   */
  options?: ImplementStepLoopOptions;
  /**
   * Review state for dimension-level tracking (#723). Tracks dirty dimensions
   * and final pair state. The loop reads and updates this object in-place.
   */
  reviewState?: ReviewState;
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
  /**
   * Enriched manifest and plan prose for task-specific context generation.
   */
  manifest: TaskManifest;
  planMd: string;
  /**
   * Convergence options (#680). Overrides any value on `Deps.options` per
   * the precedent in `ReviewFixLoopOptions`. See `ImplementStepLoopOptions`.
   */
  options?: ImplementStepLoopOptions;
}

export interface ImplementStepLoopResult {
  loop: Loop;
  outcome: 'success' | 'failed' | 'needs_human_review';
}
