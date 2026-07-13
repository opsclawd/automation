import type { RunId, PhaseName, Loop } from '@ai-sdlc/domain';
import type { LoopRepositoryPort } from '../ports/loop-repository-port.js';
import type { EventBusPort } from '../ports/event-bus-port.js';
import type { StepAgentOutcome } from '../ports/agent-invocation-types.js';
import type { ArbiterResult } from '../implement-step/types.js';
import type { ReviewMode } from '../review-state/types.js';
import type { ReviewStateRepositoryPort } from '../ports/review-state-repository-port.js';
import type { SignatureBlastRadiusFailure } from './signature-blast-radius.js';

export interface DeterministicPlanCheckResult {
  diagnostic: string | null;
  signatureBlastRadiusFailures: SignatureBlastRadiusFailure[];
}

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
  /** Invocation-metadata tagging (#719): invocation type, task/comment linkage, etc. */
  metadata?: Record<string, unknown>;
  /**
   * Structured findings parsed from the reviewer's `plan-review-findings.md`
   * artifact (#716). Loop-internal; not exposed on `PlanReviewLoopResult`.
   * When omitted (e.g. reviewer agent failure), the loop treats the review
   * as having no eligible findings.
   */
  findings?: ReadonlyArray<PlanReviewFinding>;
  /**
   * Artifact snapshot captured at review time (#723). Used by the composition
   * root to detect artifact drift between intermediate_delta and final_full
   * review passes. Undefined when the reviewer agent failed.
   */
  snapshot?: PlanReviewSnapshot;
  /**
   * The review mode used for this pass (#723). Controls prompt scope block
   * rendering and verdict semantics:
   *   - `initial_full`: first discovery pass; no scope block, no restrictions
   *   - `intermediate_delta`: subsequent delta-scoped pass; new findings must
   *     cite recent-fix text, unresolved findings carry dispositions
   *   - `final_full`: post-convergence full review against fresh snapshot;
   *     no recent-fix citation filter, runs manifest sync check
   */
  mode?: ReviewMode;
}

/**
 * Structured finding produced by the plan-review reviewer, parsed from
 * `plan-review-findings.md`. Each finding MUST have a `citation` (path:line
 * or section anchor) and a `failureScenario` (one-sentence defect
 * description) for P0/P1 severity. `evidence` reflects whether the citation
 * resolved against the artifact store (#716, AC #3).
 */
export interface PlanReviewFinding {
  severity: 'P0' | 'P1' | 'P2';
  /** Required: path:line OR section-anchor reference (e.g. `plan.md:42`). */
  citation: string;
  /** Required: one-sentence failure scenario. */
  failureScenario: string;
  /**
   * Whether the citation resolved against the artifact store at parse time.
   * Ungrounded P0/P1 findings cannot contribute to a `p1_found` verdict.
   */
  evidence: 'grounded' | 'ungrounded';
  /**
   * Current disposition of this finding in the loop, if carried forward
   * from a prior iteration.
   */
  disposition?: 'addressed' | 'rebutted' | 'still_open' | 'never_seen_again';
}

/**
 * Immutable snapshot of plan artifacts captured at review time (#723).
 * Captures digests of plan.md, task-manifest.json, and design.md so that
 * a final_full review can detect if artifacts changed during the loop.
 */
export interface PlanReviewSnapshot {
  planMdDigest: string;
  manifestDigest?: string;
  designDigest?: string;
  planMdPath: string;
  manifestPath?: string;
  designPath?: string;
  capturedAt: string;
}

/**
 * Port for resolving plan-review citations against the actual artifact
 * store (#716, design §2.3 / §3.6). Injected by the composition root
 * (`apps/api/src/compose.ts`) which has access to `ArtifactStore`.
 *
 * The application layer stays pure: the resolver is a function type, not a
 * Node-fs import. Tests inject an in-memory resolver; production binds it
 * to the artifact store backed by the run's worktree.
 *
 * Return `true` if the citation resolves, `false` otherwise. Citations that
 * resolve are marked `evidence: 'grounded'`; unresolvable citations are
 * `evidence: 'ungrounded'` and cannot contribute to a `p1_found` verdict.
 */
export type EvidenceResolver = (finding: PlanReviewFinding) => Promise<boolean>;

/**
 * Options the loop passes to `PlanReviewLoopDeps.runReview` for iteration
 * N >= 2 when delta scoping is enabled (#716).
 */
export interface PlanReviewStepOptions {
  /**
   * The finding set frozen at the end of iteration 1's review. The loop
   * keeps this constant across iterations; the reviewer uses it as the
   * "previously open findings" payload for the SCOPE/DISPOSITION GUIDANCE
   * block.
   */
  prevFindings?: ReadonlyArray<PlanReviewFinding>;
  /**
   * Citations for text introduced by the most recent fix invocation. A
   * new finding whose citation is in this set is eligible to contribute
   * to the verdict on iteration N >= 2; findings outside this set are
   * dropped from verdict computation as `out_of_scope`.
   *
   * Populated by the loop-internal `lastFixDiffCitations` state, which the
   * composition-root adapter refreshes after each fix invocation via
   * `deps.computeLastFixDiffCitations(ctx.cwd, headBeforeFix)` (#716,
   * design §2.5 / §7.1).
   */
  recentFixCitations?: ReadonlyArray<string>;
  /**
   * The artifact snapshot from the iteration-1 review (#723). Used by
   * `buildPlanReviewReviewScopeBlock` to render the mode/snapshot scope
   * block and by the loop to detect artifact drift between passes.
   * Present on iteration >= 2 when a snapshot was captured in iter 1.
   */
  snapshot?: PlanReviewSnapshot;
  /**
   * The review mode for this pass (#723):
   *   - `intermediate_delta`: delta-scoped re-review; new findings must cite
   *     recent-fix text, dispositions threaded from frozen findings
   *   - `final_full`: full review against a fresh snapshot; no recent-fix
   *     citation filter
   *
   * When omitted (undefined), the caller is a first-pass initial_full review
   * and no scope block is needed.
   */
  mode?: ReviewMode;
}

export interface PlanFixResult {
  invocationId: string;
  agentOutcome: StepAgentOutcome;
  verdict?: 'done_with_fixes' | 'done_no_fixes_needed' | 'cannot_fix';
  rebuttal?: string;
  summary?: string;
  /** Invocation-metadata tagging (#719): invocation type, task/comment linkage, etc. */
  metadata?: Record<string, unknown>;
  /**
   * The git HEAD SHA captured BEFORE the fixer wrote its commit (#716,
   * design §7.1). The composition-root adapter computes
   * `git diff <headBeforeFix>..HEAD -- plan.md` line ranges from this and
   * the loop uses them as `lastFixDiffCitations` for the next iteration's
   * SCOPE block.
   *
   * Populated by `planReviewRunFix` in `apps/api/src/compose.ts` from the
   * `startCommitSha` it captures before invoking the fixer. When absent
   * (e.g. fixer failure, or `agentOutcome !== 'success'`), the loop treats
   * the next iteration as having no recent-fix citations — every new
   * finding from the reviewer is classified `out_of_scope` and dropped from
   * verdict computation. This is the safe default: never promote a
   * citation to in-scope when we cannot prove the fix touched it.
   */
  headBeforeFix?: string;
}

export interface PlanFixOptions {
  historyContext?: string;
  reconciliationContext?: string;
  deterministicDiagnostic?: string;
  metadata?: Record<string, unknown>;
  isTerminalFix?: boolean;
  triggerReason?: string;
}

export interface PlanReviewLoopOptions {
  /**
   * When true (default), grant exactly one additional fix iteration if the
   * trailing review arbiter rules `finding_valid`.
   */
  bonusIteration?: boolean;
  /**
   * When true (default), iteration >= 2 threads `prevFindings` +
   * `recentFixCitations` into `runReview` and enforces the evidence-bound
   * gate + out-of-scope drop (#716). Set to false to restore pre-#716
   * behavior bit-for-bit. Mirrors `ReviewFixLoopOptions.deltaScopedReReview`.
   */
  deltaScopedReReview?: boolean;
}

export interface PlanReviewLoopDeps {
  runReview: (ctx: PlanReviewContext, opts?: PlanReviewStepOptions) => Promise<PlanReviewResult>;
  /**
   * Composition-root seam for refreshing the loop's internal
   * `lastFixDiffCitations` after each fix invocation (#716, fix to reviewer
   * finding #1). The loop calls this with the `headBeforeFix` SHA captured
   * by the fixer adapter; the composition root uses it to compute
   * `git diff <headBeforeFix>..HEAD -- plan.md` line ranges and returns
   * them as `plan.md:N` or `plan.md:N-M` citation strings.
   *
   * When `headBeforeFix` is undefined (fixer failure, no fix this
   * iteration), the composition root returns `[]` — every new finding
   * from the next reviewer is classified `out_of_scope` and dropped from
   * verdict computation (the safe default per reviewer finding #1).
   *
   * The application package does NOT call `git` directly; this dep is
   * the layer-rule-safe indirection.
   *
   * The first parameter is the per-iteration `cwd` (#716, fix to reviewer
   * finding #2: do not read `cwd` from a shared mutable closure in the
   * composition root — overlapping plan-review runs would compute
   * citations against the wrong workspace). Always thread the active
   * `ctx.cwd` through; never store it on a closure variable that could
   * be overwritten by a concurrent run.
   */
  computeLastFixDiffCitations: (
    cwd: string,
    headBeforeFix: string | undefined,
  ) => ReadonlyArray<string>;
  runFix: (ctx: PlanReviewContext, opts: PlanFixOptions) => Promise<PlanFixResult>;
  /**
   * Deterministic, no-LLM-call structural and blast-radius check.
   * Runs `validatePlanTaskList` for structural sync and
   * `SignatureReferenceAnalyzerPort` for blast-radius analysis.
   * Returns a combined diagnostic string (or null when in sync)
   * and any blast-radius failures for structured event emission.
   */
  checkDeterministicPlan: (ctx: PlanReviewContext) => Promise<DeterministicPlanCheckResult>;
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
  /**
   * Port for persisting plan review attempts and dimension states (#723).
   * The loop appends an `ReviewAttempt` after every review invocation
   * (initial, intermediate, final) so that historical runs can be resumed
   * in broad mode when no prior snapshot exists.
   */
  reviewStateRepository?: ReviewStateRepositoryPort;
  terminalFixProfile?: string | undefined;
  validateTerminalFix?: ((ctx: PlanReviewContext) => Promise<TerminalValidationResult>) | undefined;
}

export interface TerminalValidationResult {
  passed: boolean;
  diagnostics: string[];
  changedArtifacts: Record<string, { priorDigest: string; postDigest: string }>;
  summary: string;
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
