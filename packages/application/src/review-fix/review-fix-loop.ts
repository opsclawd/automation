import {
  createLoop,
  startIteration,
  completeIteration,
  canIterate,
  exhaust,
  type AgentProfileName,
} from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { detectStall } from './detect-stall.js';
import type {
  ReviewFixLoopDeps,
  ReviewFixLoopInput,
  ReviewFixLoopResult,
  StepContext,
  PostFixGateResult,
  ReviewLoopHistoryAudience,
} from './types.js';

export class ReviewFixLoop {
  constructor(private readonly deps: ReviewFixLoopDeps) {}

  async execute(input: ReviewFixLoopInput): Promise<ReviewFixLoopResult> {
    const { deps } = this;
    let loop = createLoop({
      id: deps.idFactory(),
      runId: input.runId,
      phaseId: input.phaseId,
      type: 'review-fix',
      maxIterations: input.maxIterations,
      now: deps.now(),
    });
    deps.loops.insert(loop);

    let consecutiveFixFailures = 0;
    let lastFixInvocationId: string | undefined;
    let lastFailingCategory: string | undefined;
    let lastIterationHadFixCommit = false;
    let outstandingFailedRevalidation = false;
    const findingHistory: Array<Set<string>> = [];

    while (canIterate(loop)) {
      const iterationIndex = loop.iterations.length + 1;
      const ctx: StepContext = {
        loopId: loop.id,
        runId: input.runId,
        phaseId: input.phaseId,
        repoId: input.repoId,
        cwd: input.cwd,
        iterationIndex,
      };

      // --- POST-FIX GATE (skip iteration 1 — fixer has not yet committed) ---
      let gateResult: PostFixGateResult | undefined;
      if (iterationIndex > 1 && lastIterationHadFixCommit) {
        gateResult = await deps.runPostFixGate(ctx);
      }

      // --- REVIEW ---
      this.emit(
        input,
        'loop.iteration.started',
        'info',
        `review/fix iteration ${iterationIndex} started`,
        {
          index: iterationIndex,
        },
      );
      const historyContext = await this.readHistoryContext(ctx, 'reviewer');
      const reviewOptions = {
        ...(gateResult ? { gateResult } : {}),
        ...(historyContext ? { historyContext } : {}),
      };
      const review = await deps.runReview(
        ctx,
        Object.keys(reviewOptions).length > 0 ? reviewOptions : undefined,
      );
      if (review.overridden) {
        const direction: 'upgrade' | 'downgrade' =
          review.verdict === 'fail' ? 'upgrade' : 'downgrade';
        const message =
          direction === 'upgrade'
            ? `review returned pass but severity gate overrode to fail`
            : `review returned fail but severity gate overrode to pass (all findings below threshold)`;
        this.emit(input, 'review.verdict.overridden', 'warn', message, {
          direction,
          iterationIndex,
          offendingFindings: review.offendingFindings ?? [],
          threshold: input.blockOnSeverity ?? 'high',
        });
      }
      loop = startIteration(loop, { reviewInvocationId: review.invocationId, now: deps.now() });
      deps.loops.update(loop);

      if (review.agentOutcome !== 'success' || review.verdict === undefined) {
        loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
        deps.loops.update(loop);
        this.emitIterationCompleted(input, iterationIndex, 'failed');
        await this.runCleanArtifacts(ctx);
        break;
      }

      if (review.verdict === 'pass') {
        if (outstandingFailedRevalidation) {
          const reval = await deps.runRevalidation(ctx);
          outstandingFailedRevalidation = !reval.passed;
          if (reval.passed) {
            loop = completeIteration(loop, { outcome: 'resolved', now: deps.now() });
            deps.loops.update(loop);
            this.emitIterationCompleted(input, iterationIndex, 'resolved');
            break;
          }
          loop = completeIteration(loop, {
            outcome: 'unresolved',
            revalidationId: reval.validationRunId,
            now: deps.now(),
          });
          deps.loops.update(loop);
          this.emitIterationCompleted(input, iterationIndex, 'unresolved');
          continue;
        }
        loop = completeIteration(loop, { outcome: 'resolved', now: deps.now() });
        deps.loops.update(loop);
        this.emitIterationCompleted(input, iterationIndex, 'resolved');
        break;
      }

      // --- OSCILLATION / STALL DETECTION ---
      const normalizedFindings = new Set(
        (review.offendingFindings ?? []).map((f) => (f.summary ?? '').trim().toLowerCase()),
      );
      findingHistory.push(normalizedFindings);
      if (findingHistory.length > 3) {
        findingHistory.splice(0, findingHistory.length - 3);
      }
      const stall = detectStall(findingHistory);

      // --- decide fallback (use-case-owned triggers) ---
      const escalateForFixFailures =
        consecutiveFixFailures >= 2 && input.fixFallbackProfile !== undefined;
      const escalateForStall = stall !== 'none' && input.fixFallbackProfile !== undefined;
      const useFallback = escalateForFixFailures || escalateForStall;
      if (escalateForFixFailures) {
        this.emitEscalation(input, 'two_consecutive_fix_failures');
      }
      if (escalateForStall) {
        this.emitEscalation(
          input,
          stall === 'oscillation' ? 'oscillation_detected' : 'no_progress_detected',
        );
      }

      // --- FIX ---
      const fixerHistoryContext = await this.readHistoryContext(ctx, 'fixer');
      const fix = await deps.runFix(ctx, {
        useFallback,
        ...(useFallback && lastFixInvocationId !== undefined
          ? { previousInvocationId: lastFixInvocationId }
          : {}),
        ...(input.architectPlan !== undefined ? { architectPlan: input.architectPlan } : {}),
        ...(fixerHistoryContext ? { historyContext: fixerHistoryContext } : {}),
      });
      lastFixInvocationId = fix.invocationId;

      if (
        fix.agentOutcome !== 'success' ||
        fix.verdict === undefined ||
        fix.verdict === 'cannot_fix'
      ) {
        consecutiveFixFailures += 1;
        lastIterationHadFixCommit = false;
        loop = completeIteration(loop, {
          outcome: 'unresolved',
          fixInvocationId: fix.invocationId,
          now: deps.now(),
        });
        deps.loops.update(loop);
        this.emitIterationCompleted(input, iterationIndex, 'unresolved');
        await this.runCleanArtifacts(ctx);
        continue;
      }
      consecutiveFixFailures = 0;
      lastIterationHadFixCommit = fix.verdict === 'done_with_fixes';

      // --- REVALIDATE ---
      const reval = await deps.runRevalidation(ctx);
      outstandingFailedRevalidation = !reval.passed;

      // When revalidation fails after a fix that advanced HEAD, roll back
      // the fix commit so the next iteration starts from the pre-fix baseline
      // rather than a commit already known to break validation. This prevents
      // an exhausted loop or resumed run from inheriting unvalidated changes.
      if (!reval.passed && fix.headBeforeFix && deps.rollbackFix) {
        await deps.rollbackFix(ctx, fix.headBeforeFix);
      }

      // category-change trigger: if this revalidation failed with a different
      // category than the previous failing one, escalate the NEXT fix.
      if (!reval.passed && reval.category !== undefined) {
        if (lastFailingCategory !== undefined && lastFailingCategory !== reval.category) {
          if (input.fixFallbackProfile !== undefined) {
            consecutiveFixFailures = 2;
            this.emitEscalation(input, 'validation_category_changed');
          }
        }
        lastFailingCategory = reval.category;
      }

      loop = completeIteration(loop, {
        outcome: reval.passed ? 'fixed' : 'unresolved',
        fixInvocationId: fix.invocationId,
        revalidationId: reval.validationRunId,
        now: deps.now(),
      });
      deps.loops.update(loop);
      this.emitIterationCompleted(input, iterationIndex, reval.passed ? 'fixed' : 'unresolved');
    }

    if (loop.status === 'converged') {
      return { loop, phaseOutcome: 'passed' };
    }
    if (loop.status === 'failed') {
      return { loop, phaseOutcome: 'failed' };
    }
    loop = exhaust(loop, this.deps.now());
    this.deps.loops.update(loop);
    this.emit(
      input,
      'loop.exhausted',
      'error',
      `review/fix loop exhausted after ${loop.iterations.length} iterations`,
      {
        iterations: loop.iterations.length,
        maxIterations: loop.maxIterations,
      },
    );
    return { loop, phaseOutcome: 'failed' };
  }

  private emit(
    input: ReviewFixLoopInput,
    type: string,
    level: OrchestratorEvent['level'],
    message: string,
    metadata: Record<string, unknown>,
  ): void {
    this.deps.events.publish(input.runId as unknown as string, {
      runId: input.runId as unknown as string,
      phase: input.phaseId as unknown as string,
      level,
      type,
      message,
      timestamp: this.deps.now().toISOString(),
      metadata,
    });
  }

  private emitIterationCompleted(input: ReviewFixLoopInput, index: number, outcome: string): void {
    this.emit(
      input,
      'loop.iteration.completed',
      'info',
      `iteration ${index} completed: ${outcome}`,
      {
        index,
        outcome,
      },
    );
  }

  private emitEscalation(input: ReviewFixLoopInput, triggerReason: string): void {
    const toProfile = input.fixFallbackProfile as AgentProfileName;
    this.emit(input, 'phase.fallback.escalated', 'warn', `escalating fix to ${toProfile}`, {
      fromProfile: input.fixProfile as unknown as string,
      toProfile: toProfile as unknown as string,
      triggerReason,
      triggerOwner: 'use_case',
    });
  }

  private async runCleanArtifacts(ctx: StepContext): Promise<void> {
    if (this.deps.cleanArtifacts) {
      await this.deps.cleanArtifacts(ctx);
    }
  }

  private async readHistoryContext(
    ctx: StepContext,
    audience: ReviewLoopHistoryAudience,
  ): Promise<string | undefined> {
    if (!this.deps.loopHistory) {
      return undefined;
    }
    const history = await this.deps.loopHistory.read(ctx);
    if (!history || history.length === 0) {
      return undefined;
    }
    return this.deps.loopHistory.format(history, audience);
  }
}
