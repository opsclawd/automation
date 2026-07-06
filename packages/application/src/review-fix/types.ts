import type { RunId, PhaseName, AgentProfileName, Loop } from '@ai-sdlc/domain';
import type { LoopRepositoryPort } from '../ports/loop-repository-port.js';
import type { EventBusPort } from '../ports/event-bus-port.js';
import type { StepAgentOutcome } from '../ports/agent-invocation-types.js';
import type { FindingEvidenceInspectorPort } from '../ports/finding-evidence-inspector-port.js';
import type { ArtifactStore } from '../ports.js';

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
  /**
   * The commit SHA at the start of this review's diff scope — captured by
   * the adapter (apps/api/src/compose.ts::runReview) before the reviewer
   * was invoked. On iteration N≥2, the reviewer prompt's `git diff`
   * command is constrained to `git diff <prevReviewedSha>..HEAD`, so this
   * field also serves as the "previously reviewed SHA" for the next
   * iteration's delta scope.
   *
   * Undefined on iteration 1 (the reviewer sees the whole feature diff).
   */
  reviewedCommitSha?: string;
}

export interface FixStepResult {
  invocationId: string;
  agentOutcome: StepAgentOutcome;
  verdict?: 'done_with_fixes' | 'done_no_fixes_needed' | 'cannot_fix';
  headBeforeFix?: string; // commit SHA before the fix, for rollback on revalidation failure
  summary?: string;
  /**
   * Required (non-empty) when verdict === 'done_no_fixes_needed' by the
   * fix-review schema. Carried so the loop can append it to `code-review.md`
   * when the rebuttal is accepted.
   */
  rebuttal?: string;
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

export interface ReviewFixLoopOptions {
  endOnReview?: boolean;
  deltaScopedReReview?: boolean;
  trendAwareExit?: {
    enabled?: boolean;
    mode?: 'strict' | 'lenient';
    window?: number;
  };
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
  /**
   * Mechanically validates reviewer evidence against the working tree at the
   * iteration's head. Required for the rebuttal-aware convergence branch.
   * If absent, the loop falls back to the existing pre-#623 behavior.
   */
  findingEvidenceInspector?: FindingEvidenceInspectorPort;
  /**
   * Used to append an accepted rebuttal to `code-review.md` so the human /
   * PR-review stage sees what was disputed. If absent, the rebuttal is
   * dropped silently (with a `review.rebuttal.append_skipped` event).
   */
  artifactStore?: ArtifactStore;
  /**
   * Threshold for `unfounded_pingpong` short-circuit. When the last
   * `unfoundedPingPongLimit` iterations all have unfounded findings AND
   * the fixer returned `done_no_fixes_needed`, return `needsHumanReview`.
   * Defaults to 4 when omitted.
   */
  unfoundedPingPongLimit?: number;
  /**
   * Convergence-on-large-diffs options (#627). All three default to ON —
   * see `packages/shared/src/config/schema.ts` for the always-on defaults.
   *
   * - `endOnReview`: when true, the budget grants one trailing post-fix
   *   re-review whenever the last iteration ended with `outcome: 'fixed'`.
   *   The post-fix re-review does NOT count against `maxIterations`.
   * - `deltaScopedReReview`: when true, iteration ≥2 scopes the reviewer
   *   to `git diff <prevReviewedCommitSha>..HEAD` instead of the full
   *   feature diff.
   * - `trendAwareExit`: when enabled, the loop invokes
   *   `detectConvergingTrend` at budget exhaustion and exits as
   *   `converged_with_notes` (with `needsHumanReview: true`) when the
   *   severity-weighted finding count is trending down.
   *
   * Set `endOnReview: false` to restore pre-#627 behavior bit-for-bit.
   */
  options?: ReviewFixLoopOptions;
}

export type ReviewLoopHistoryAudience = 'reviewer' | 'fixer';

export interface ReviewLoopHistoryEntry {
  iteration: number;
  review: {
    verdict?: 'pass' | 'fail';
    invocationId?: string;
    offendingFindings?: Array<{ severity: string; summary: string }>;
    excerpt?: string;
    reviewedCommitSha?: string;
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
  /**
   * The SHA the previous review was scoped to. When iterationIndex >= 2,
   * the reviewer prompt's `git diff` command is constrained to
   * `git diff <prevReviewedCommitSha>..HEAD`. Undefined on iteration 1.
   */
  prevReviewedCommitSha?: string;
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
  options?: ReviewFixLoopOptions;
}

export interface ReviewFixLoopResult {
  loop: Loop;
  phaseOutcome: 'passed' | 'failed';
  loopStatus: 'converged' | 'converged_with_notes' | 'failed' | 'exhausted';
  /**
   * True iff the loop short-circuited via the `unfounded_pingpong` path
   * or another `needs_human_review` branch. Mapped by the handler to
   * `Failure { kind: 'needs_human_review' }` so the run lifecycle reaches
   * `RUN_STATUS.needs_human_review`.
   */
  needsHumanReview?: boolean;
}
