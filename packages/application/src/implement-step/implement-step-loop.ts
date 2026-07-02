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
  SpecReviewResult,
  StepLoopContext,
  TypecheckResult,
} from './types.js';

function normalizeMessage(message: string): string {
  return message.trim().replace(/\s+/g, ' ').toLowerCase();
}

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
    let arbiterInvokedThisStep = false;
    let pendingReconciliationContext: string | undefined;

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
    const maxTypeCheckRetries = input.maxTypeCheckRetries ?? 2;
    let typecheckRetryCount = 0;
    let prevFingerprint: string | null = null;

    while (tcResult.outcome === 'fail' && typecheckRetryCount < maxTypeCheckRetries) {
      // Stall detection: if same fingerprint as previous attempt, escalate immediately
      const currFingerprint = this.fingerprintTypecheck(tcResult);
      if (prevFingerprint !== null && currFingerprint === prevFingerprint) {
        this.emit(
          input,
          'step.typecheck.stalled',
          'error',
          `step ${input.stepIndex} typecheck stalled — same errors as previous attempt; escalating`,
          {
            index: input.stepIndex,
            attempt: typecheckRetryCount,
            fingerprint: currFingerprint.slice(0, 500),
          },
        );
        this.emit(
          input,
          'step.typecheck.failed',
          'error',
          `step ${input.stepIndex} failed typecheck gate (stalled)`,
          {
            index: input.stepIndex,
            output: tcResult.output.slice(0, 2000),
            stalled: true,
          },
        );
        this.emit(input, 'loop.iteration.started', 'info', 'typecheck stalled', { index: 1 });
        loop = startIteration(loop, { reviewInvocationId: '', now: deps.now() });
        loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
        deps.loops.update(loop);
        this.emit(input, 'loop.iteration.completed', 'info', 'step stalled at typecheck gate', {
          index: 1,
          outcome: 'failed',
        });
        return { outcome: 'failed', loop };
      }
      prevFingerprint = currFingerprint;

      typecheckRetryCount += 1;
      this.emit(
        input,
        'step.typecheck.retry',
        'warn',
        `step ${input.stepIndex} failed typecheck gate; retrying implement attempt ${typecheckRetryCount}/${maxTypeCheckRetries}`,
        {
          attempt: typecheckRetryCount,
          maxRetries: maxTypeCheckRetries,
          index: input.stepIndex,
          output: tcResult.output.slice(0, 2000),
        },
      );

      const retryImplementResult = await deps.runImplement(baseCtx, {
        ...(tcResult.structuredErrors !== undefined && tcResult.structuredErrors.length > 0
          ? { typecheckErrors: tcResult.structuredErrors }
          : tcResult.output.length > 0
            ? { typecheckErrors: tcResult.output.slice(0, 2000) }
            : {}),
      });

      if (retryImplementResult.agentOutcome !== 'success') {
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

      tcResult = await deps.runTypecheck(baseCtx);
    }

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

      // --- SPEC-REVIEW (with targeted retry) ---
      const MAX_SPEC_REVIEW_ATTEMPTS = 3;
      let specReview: SpecReviewResult;
      let specReviewAttempts = 0;
      const specReviewAttemptInvocationIds: string[] = [];
      do {
        specReviewAttempts += 1;
        specReview = await deps.runSpecReview(ctx, tcResult);
        specReviewAttemptInvocationIds.push(specReview.invocationId);

        if (specReview.agentOutcome === 'success' && specReview.verdict !== undefined) {
          break;
        }

        if (specReviewAttempts < MAX_SPEC_REVIEW_ATTEMPTS) {
          this.emit(
            input,
            'step.spec-review.retry',
            'warn',
            `spec-review attempt ${specReviewAttempts} failed (invocation ${specReview.invocationId}), retrying...`,
            {
              attempt: specReviewAttempts,
              maxAttempts: MAX_SPEC_REVIEW_ATTEMPTS,
              agentOutcome: specReview.agentOutcome,
              hasVerdict: specReview.verdict !== undefined,
              invocationId: specReview.invocationId,
            },
          );
        }
      } while (specReviewAttempts < MAX_SPEC_REVIEW_ATTEMPTS);

      this.emit(
        input,
        'step.spec-review.attempts',
        'info',
        `spec-review completed after ${specReviewAttempts} attempt(s)`,
        {
          index: iterationIndex,
          attempts: specReviewAttempts,
          invocationIds: specReviewAttemptInvocationIds,
        },
      );

      loop = startIteration(loop, {
        reviewInvocationId: specReview.invocationId,
        now: deps.now(),
      });

      if (specReview.agentOutcome !== 'success' || specReview.verdict === undefined) {
        loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
        deps.loops.update(loop);
        this.emitIterationCompleted(input, iterationIndex, 'failed');
        return { outcome: 'failed', loop };
      }
      deps.loops.update(loop);

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
        ...(pendingReconciliationContext !== undefined
          ? { reconciliationContext: pendingReconciliationContext }
          : {}),
        ...(useFallback && lastFixInvocationId !== undefined
          ? { previousInvocationId: lastFixInvocationId }
          : {}),
      });
      pendingReconciliationContext = undefined; // consumed
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

        // --- ARBITER ESCALATION ---
        if (!arbiterInvokedThisStep && deps.runArbiter !== undefined) {
          arbiterInvokedThisStep = true;
          this.emit(
            input,
            'review.contradiction.escalated',
            'warn',
            `escalating review/fix contradiction to arbiter at iteration ${iterationIndex}`,
            {
              toProfile: deps.fixFallbackProfile ?? 'none',
              reason: 'contradiction_not_resolved_by_rerun',
              iterationIndex,
            },
          );

          const arbiterResult = await deps.runArbiter(ctx, tcResult, fix);

          // G1 guardrail: empty evidence → human review, never auto-proceed
          if (!arbiterResult.evidence || arbiterResult.evidence.trim().length === 0) {
            this.emit(
              input,
              'needs_human_review',
              'warn',
              `arbiter returned empty evidence at iteration ${iterationIndex} — escalating to human`,
              { iterationIndex, outcome: arbiterResult.outcome },
            );
            loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
            deps.loops.update(loop);
            return { outcome: 'needs_human_review', loop };
          }

          if (arbiterResult.outcome === 'finding_invalid') {
            this.emit(
              input,
              'review.contradiction.resolved',
              'info',
              `arbiter resolved contradiction at iteration ${iterationIndex}: ${arbiterResult.outcome}`,
              {
                ruling: arbiterResult.outcome,
                evidence: arbiterResult.evidence,
                iterationIndex,
              },
            );
            // Reviewer was wrong — the step is complete
            loop = completeIteration(loop, { outcome: 'resolved', now: deps.now() });
            deps.loops.update(loop);
            this.emitIterationCompleted(input, iterationIndex, 'resolved');
            return { outcome: 'success', loop };
          }

          if (arbiterResult.outcome === 'finding_valid') {
            this.emit(
              input,
              'review.contradiction.resolved',
              'info',
              `arbiter resolved contradiction at iteration ${iterationIndex}: ${arbiterResult.outcome}`,
              {
                ruling: arbiterResult.outcome,
                evidence: arbiterResult.evidence,
                iterationIndex,
              },
            );
            // Fixer was wrong — carry arbiter rationale into next fix call
            pendingReconciliationContext = arbiterResult.rationale;
            loop = completeIteration(loop, {
              outcome: 'unresolved',
              fixInvocationId: fix.invocationId,
              now: deps.now(),
            });
            deps.loops.update(loop);
            this.emitIterationCompleted(input, iterationIndex, 'unresolved');
            consecutiveFixFailures = 0; // arbiter ruled fixer wrong (not incapable) — reset counter
            continue; // next iteration: reviews run, then fix with reconciliationContext
          }

          // ambiguous or insufficient_evidence
          this.emit(
            input,
            'needs_human_review',
            'warn',
            `arbiter could not resolve contradiction at iteration ${iterationIndex}: ${arbiterResult.outcome}`,
            { ruling: arbiterResult.outcome, evidence: arbiterResult.evidence, iterationIndex },
          );
          loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
          deps.loops.update(loop);
          return { outcome: 'needs_human_review', loop };
        }

        // Arbiter already invoked this step, or not configured — human escalation
        this.emit(
          input,
          'needs_human_review',
          'warn',
          arbiterInvokedThisStep
            ? `second contradiction after arbiter at iteration ${iterationIndex} — escalating to human`
            : `contradiction after 1-shot re-run with no arbiter configured at iteration ${iterationIndex}`,
          { iterationIndex, arbiterInvokedThisStep },
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

  private fingerprintTypecheck(tcResult: TypecheckResult): string {
    const errors = tcResult.structuredErrors;
    if (errors !== undefined && errors.length > 0) {
      return [...errors]
        .sort((a, b) =>
          `${a.file}:${a.line}:${a.col}:${a.code}`.localeCompare(
            `${b.file}:${b.line}:${b.col}:${b.code}`,
          ),
        )
        .map((e) => `${e.file}:${e.line}:${e.col}:${e.code}:${normalizeMessage(e.message)}`)
        .join('\n');
    }
    return tcResult.output;
  }
}
