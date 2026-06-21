import {
  createLoop,
  startIteration,
  completeIteration,
  canIterate,
  exhaust,
  updateOpenIteration,
} from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import type {
  ImplementStepLoopDeps,
  ImplementStepLoopInput,
  ImplementStepLoopResult,
  StepLoopContext,
} from './types.js';

export class ImplementStepLoop {
  constructor(private readonly deps: ImplementStepLoopDeps) {}

  async execute(input: ImplementStepLoopInput): Promise<ImplementStepLoopResult> {
    const { deps } = this;
    let loop = createLoop({
      id: deps.idFactory(),
      runId: input.runId,
      phaseId: input.phaseId,
      type: 'implement-step',
      maxIterations: input.maxIterations,
      now: deps.now(),
    });
    deps.loops.insert(loop);

    let consecutiveFixFailures = 0;
    let lastFixInvocationId: string | undefined;
    let contradictionRetriedThisStep = false;
    let _arbiterInvokedThisStep = false; // used by Task 3 (arbiter escalation)
    let _pendingReconciliationContext: string | undefined; // used by Task 3 (arbiter escalation)

    const baseCtx: StepLoopContext = {
      loopId: loop.id,
      runId: input.runId,
      phaseId: input.phaseId,
      repoId: input.repoId,
      cwd: input.cwd,
      stepIndex: input.stepIndex,
      stepTitle: input.stepTitle,
      iterationIndex: 1,
    };

    // --- PRE-LOOP: IMPLEMENT ---
    const implementResult = await deps.runImplement(baseCtx);
    if (implementResult.agentOutcome !== 'success') {
      this.emit(input, 'loop.iteration.started', 'info', 'implementation step started', {
        index: 1,
      });
      loop = startIteration(loop, {
        reviewInvocationId: '',
        now: deps.now(),
      });
      loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
      deps.loops.update(loop);
      this.emit(input, 'loop.iteration.completed', 'info', 'implement step failed', {
        index: 1,
        outcome: 'failed',
      });
      return { outcome: 'failed', loop };
    }

    // --- PRE-LOOP: TYPECHECK GATE ---
    let tcResult = await deps.runTypecheck(baseCtx);
    if (tcResult.outcome === 'fail') {
      this.emit(
        input,
        'step.typecheck.failed',
        'error',
        `step ${input.stepIndex} failed typecheck gate`,
        {
          index: input.stepIndex,
          output: tcResult.output.slice(0, 2000),
        },
      );
      this.emit(input, 'loop.iteration.started', 'info', 'typecheck gate failed', { index: 1 });
      loop = startIteration(loop, { reviewInvocationId: '', now: deps.now() });
      loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
      deps.loops.update(loop);
      this.emit(input, 'loop.iteration.completed', 'info', 'step failed typecheck gate', {
        index: 1,
        outcome: 'failed',
      });
      return { outcome: 'failed', loop };
    }

    // Enter review-fix loop
    while (canIterate(loop)) {
      const iterationIndex = loop.iterations.length + 1;
      const ctx: StepLoopContext = { ...baseCtx, iterationIndex };

      // Re-run typecheck on iterations 2+ (code may have changed after fix)
      if (iterationIndex > 1) {
        tcResult = await deps.runTypecheck(baseCtx);
        if (tcResult.outcome === 'fail') {
          this.emit(
            input,
            'step.typecheck.failed',
            'error',
            `step ${input.stepIndex} iteration ${iterationIndex} typecheck failed after fix`,
            {
              index: input.stepIndex,
              iteration: iterationIndex,
              output: tcResult.output.slice(0, 2000),
            },
          );
          this.emit(
            input,
            'loop.iteration.started',
            'info',
            `iteration ${iterationIndex} started`,
            {
              index: iterationIndex,
            },
          );
          loop = startIteration(loop, { reviewInvocationId: '', now: deps.now() });
          loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
          deps.loops.update(loop);
          this.emitIterationCompleted(input, iterationIndex, 'failed');
          return { outcome: 'failed', loop };
        }
      }

      this.emit(input, 'loop.iteration.started', 'info', `iteration ${iterationIndex} started`, {
        index: iterationIndex,
      });

      // --- SPEC-REVIEW ---
      const specReview = await deps.runSpecReview(ctx, tcResult);
      loop = startIteration(loop, {
        reviewInvocationId: specReview.invocationId,
        now: deps.now(),
      });
      deps.loops.update(loop);

      if (specReview.agentOutcome !== 'success' || specReview.verdict === undefined) {
        loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
        deps.loops.update(loop);
        this.emitIterationCompleted(input, iterationIndex, 'failed');
        return { outcome: 'failed', loop };
      }

      // --- QUALITY-REVIEW ---
      const qualityReview = await deps.runQualityReview(ctx, tcResult);
      loop = updateOpenIteration(loop, { qualityReviewInvocationId: qualityReview.invocationId });
      deps.loops.update(loop);
      if (qualityReview.agentOutcome !== 'success' || qualityReview.verdict === undefined) {
        loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
        deps.loops.update(loop);
        this.emitIterationCompleted(input, iterationIndex, 'failed');
        return { outcome: 'failed', loop };
      }

      // Both passed?
      if (specReview.verdict === 'pass' && qualityReview.verdict === 'pass') {
        loop = completeIteration(loop, { outcome: 'resolved', now: deps.now() });
        deps.loops.update(loop);
        this.emitIterationCompleted(input, iterationIndex, 'resolved');
        return { outcome: 'success', loop };
      }

      // --- FALLBACK ESCALATION ---
      const escalateForFixFailures = consecutiveFixFailures >= 2;
      const useFallback = escalateForFixFailures && deps.fixFallbackProfile !== undefined;
      if (useFallback) {
        this.emitEscalation(input, 'two_consecutive_fix_failures');
      }

      // --- FIX ---
      const fix = await deps.runFix(ctx, {
        useFallback,
        ...(useFallback && lastFixInvocationId !== undefined
          ? { previousInvocationId: lastFixInvocationId }
          : {}),
      });
      lastFixInvocationId = fix.invocationId;

      if (
        fix.agentOutcome !== 'success' ||
        fix.verdict === undefined ||
        fix.verdict === 'cannot_fix'
      ) {
        consecutiveFixFailures += 1;
        loop = completeIteration(loop, {
          outcome: 'unresolved',
          fixInvocationId: fix.invocationId,
          now: deps.now(),
        });
        deps.loops.update(loop);
        this.emitIterationCompleted(input, iterationIndex, 'unresolved');
        continue;
      }

      // --- CONTRADICTION DETECTION ---
      const reviewFailed = specReview.verdict === 'fail' || qualityReview.verdict === 'fail';
      if (fix.verdict === 'done_no_fixes_needed' && reviewFailed) {
        this.emit(
          input,
          'review.contradiction.detected',
          'warn',
          `review/fix contradiction at iteration ${iterationIndex}: fixer disagrees with failing review`,
          {
            iterationIndex,
            specVerdict: specReview.verdict,
            qualityVerdict: qualityReview.verdict,
            hasRebuttal: Boolean(fix.rebuttal),
          },
        );

        // --- 1-SHOT RECONCILIATION RE-RUN (#45 port) ---
        if (!contradictionRetriedThisStep) {
          contradictionRetriedThisStep = true;

          const rerunSpec =
            specReview.verdict === 'fail' ? await deps.runSpecReview(ctx, tcResult) : specReview;
          const rerunQuality =
            qualityReview.verdict === 'fail'
              ? await deps.runQualityReview(ctx, tcResult)
              : qualityReview;

          const rerunSpecOk = rerunSpec.agentOutcome === 'success' && rerunSpec.verdict === 'pass';
          const rerunQualityOk =
            rerunQuality.agentOutcome === 'success' && rerunQuality.verdict === 'pass';

          if (rerunSpecOk && rerunQualityOk) {
            // Contradiction resolved by re-run
            loop = completeIteration(loop, { outcome: 'resolved', now: deps.now() });
            deps.loops.update(loop);
            this.emitIterationCompleted(input, iterationIndex, 'resolved');
            return { outcome: 'success', loop };
          }
          // Re-run still failing — fall through to arbiter (Task 3 adds this path)
        }

        // --- NO ARBITER / ARBITER ALREADY USED (placeholder until Task 3) ---
        // Emit needs_human_review and exit; Task 3 replaces this with arbiter call.
        this.emit(
          input,
          'needs_human_review',
          'warn',
          `contradiction unresolved after 1-shot re-run at iteration ${iterationIndex}`,
          { iterationIndex, arbiterAvailable: Boolean(deps.runArbiter) },
        );
        loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
        deps.loops.update(loop);
        return { outcome: 'needs_human_review', loop };
      }

      consecutiveFixFailures = 0;
      loop = completeIteration(loop, {
        outcome: 'fixed',
        fixInvocationId: fix.invocationId,
        now: deps.now(),
      });
      deps.loops.update(loop);
      this.emitIterationCompleted(input, iterationIndex, 'fixed');
    }

    // Exhausted
    loop = exhaust(loop, deps.now());
    deps.loops.update(loop);
    this.emit(
      input,
      'loop.exhausted',
      'error',
      `implement-step loop exhausted after ${loop.iterations.length} iterations`,
      {
        iterations: loop.iterations.length,
        maxIterations: loop.maxIterations,
      },
    );
    return { outcome: 'failed', loop };
  }

  private emit(
    input: ImplementStepLoopInput,
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

  private emitIterationCompleted(
    input: ImplementStepLoopInput,
    index: number,
    outcome: string,
  ): void {
    this.emit(
      input,
      'loop.iteration.completed',
      'info',
      `iteration ${index} completed: ${outcome}`,
      { index, outcome },
    );
  }

  private emitEscalation(input: ImplementStepLoopInput, triggerReason: string): void {
    const { deps } = this;
    const toProfile = deps.fixFallbackProfile!;
    this.emit(input, 'phase.fallback.escalated', 'warn', `escalating fix to ${toProfile}`, {
      fromProfile: deps.fixProfile as unknown as string,
      toProfile: toProfile as unknown as string,
      triggerReason,
      triggerOwner: 'use_case',
    });
  }
}
