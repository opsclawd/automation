import {
  createLoop,
  startIteration,
  completeIteration,
  canIterate,
  exhaust,
} from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import type {
  PlanReviewContext,
  PlanReviewLoopDeps,
  PlanReviewLoopInput,
  PlanReviewLoopResult,
  PlanReviewResult,
} from './types.js';

export const DEFAULT_REVIEWER_MAX_RETRIES = 2;

export class PlanReviewLoop {
  constructor(private readonly deps: PlanReviewLoopDeps) {}

  async execute(input: PlanReviewLoopInput): Promise<PlanReviewLoopResult> {
    const { deps } = this;
    const reviewerMaxRetries = deps.reviewerMaxRetries ?? DEFAULT_REVIEWER_MAX_RETRIES;

    let loop = createLoop({
      id: deps.idFactory(),
      runId: input.runId,
      phaseId: input.phaseId,
      type: 'plan-review',
      maxIterations: input.maxIterations,
      now: deps.now(),
    });
    deps.loops.insert(loop);

    const baseCtx: PlanReviewContext = {
      loopId: loop.id,
      runId: input.runId,
      phaseId: input.phaseId,
      repoId: input.repoId,
      cwd: input.cwd,
      iterationIndex: 1,
    };

    let pendingReconciliationContext: string | undefined;

    while (canIterate(loop)) {
      const iterationIndex = loop.iterations.length + 1;
      const ctx: PlanReviewContext = { ...baseCtx, iterationIndex };

      this.emit(
        input,
        'plan-review.loop.iteration.started',
        'info',
        `iteration ${iterationIndex} started`,
        {
          index: iterationIndex,
        },
      );

      // --- REVIEWER (with retry budget per parity #297) ---
      let review: PlanReviewResult | undefined;
      let reviewAttempts = 0;
      while (reviewAttempts <= reviewerMaxRetries) {
        reviewAttempts += 1;
        review = await deps.runReview(ctx);
        if (review.agentOutcome === 'success' && review.verdict !== undefined) break;
        if (reviewAttempts <= reviewerMaxRetries) {
          this.emit(
            input,
            'plan-review.reviewer.retry',
            'warn',
            `plan-review reviewer attempt ${reviewAttempts} failed (invocation ${review.invocationId}), retrying...`,
            {
              attempt: reviewAttempts,
              maxAttempts: reviewerMaxRetries + 1,
              agentOutcome: review.agentOutcome,
              hasVerdict: review.verdict !== undefined,
              invocationId: review.invocationId,
            },
          );
        }
      }

      if (!review || review.agentOutcome !== 'success' || review.verdict === undefined) {
        this.emit(
          input,
          'plan-review.reviewer.failed',
          'error',
          `reviewer exhausted retry budget at iteration ${iterationIndex}`,
          { iterationIndex, attempts: reviewAttempts },
        );
        loop = startIteration(loop, {
          reviewInvocationId: review?.invocationId ?? '',
          now: deps.now(),
        });
        loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
        deps.loops.update(loop);
        this.emit(
          input,
          'plan-review.loop.iteration.completed',
          'info',
          `iteration ${iterationIndex} completed: failed`,
          { index: iterationIndex, outcome: 'failed' },
        );
        return { outcome: 'failed', loop, proceedWithConcerns: false };
      }

      loop = startIteration(loop, { reviewInvocationId: review.invocationId, now: deps.now() });

      const manifestError = await deps.checkManifestSync(ctx);
      if (manifestError) {
        this.emit(
          input,
          'plan-review.manifest_mismatch.detected',
          'warn',
          `plan.md/task-manifest.json mismatch detected at iteration ${iterationIndex}: ${manifestError}`,
          { iterationIndex, manifestError },
        );
      }

      // --- RESOLUTION ON PASS / P2-ONLY ---
      if (!manifestError && (review.verdict === 'pass' || review.verdict === 'p2_only')) {
        loop = completeIteration(loop, { outcome: 'resolved', now: deps.now() });
        deps.loops.update(loop);
        this.emit(
          input,
          'plan-review.loop.iteration.completed',
          'info',
          `iteration ${iterationIndex} completed: resolved`,
          { index: iterationIndex, outcome: 'resolved' },
        );
        return { outcome: 'success', loop, proceedWithConcerns: false };
      }

      // --- PROCEED_WITH_CONCERNS — AC #3 ---
      if (!manifestError && review.verdict === 'proceed_with_concerns') {
        loop = completeIteration(loop, { outcome: 'resolved', now: deps.now() });
        deps.loops.update(loop);
        this.emit(
          input,
          'plan-review.loop.iteration.completed',
          'info',
          `iteration ${iterationIndex} completed: resolved (proceed with concerns)`,
          { index: iterationIndex, outcome: 'resolved', knownLimitations: true },
        );
        return {
          outcome: 'success',
          loop,
          proceedWithConcerns: true,
          ...(review.knownLimitations ? { knownLimitations: review.knownLimitations } : {}),
        };
      }

      // A manifest-only-triggered fix iteration is one where the reviewer
      // itself did not fail (`p1_found`) but the manifest/prose check did —
      // tracked separately so a fixer `done_no_fixes_needed` response here
      // is never misrouted into the review/fix contradiction-arbiter path
      // (there is no reviewer opinion to contradict, only a deterministic
      // structural fact the fixer is refusing to address).
      const manifestOnlyFix = manifestError !== null && review.verdict !== 'p1_found';

      // --- FIX ---
      const fix = await deps.runFix(ctx, {
        ...(pendingReconciliationContext !== undefined
          ? { reconciliationContext: pendingReconciliationContext }
          : {}),
        ...(manifestError ? { manifestMismatch: manifestError } : {}),
      });
      pendingReconciliationContext = undefined;

      if (
        fix.agentOutcome !== 'success' ||
        fix.verdict === undefined ||
        fix.verdict === 'cannot_fix'
      ) {
        loop = completeIteration(loop, {
          outcome: 'unresolved',
          fixInvocationId: fix.invocationId,
          now: deps.now(),
        });
        deps.loops.update(loop);
        this.emit(
          input,
          'plan-review.fixer.failed',
          'warn',
          `fixer could not fix findings at iteration ${iterationIndex}`,
          { iterationIndex, fixVerdict: fix.verdict, agentOutcome: fix.agentOutcome },
        );
        this.emit(
          input,
          'plan-review.loop.iteration.completed',
          'info',
          `iteration ${iterationIndex} completed: unresolved`,
          { index: iterationIndex, outcome: 'unresolved' },
        );
        continue;
      }

      // --- CONTRADICTION DETECTION ---
      const reviewFailed = review.verdict === 'p1_found';
      if (fix.verdict === 'done_no_fixes_needed' && reviewFailed && !manifestOnlyFix) {
        this.emit(
          input,
          'plan-review.review.contradiction.detected',
          'warn',
          `review/fix contradiction at iteration ${iterationIndex}: fixer disagrees with failing review`,
          {
            iterationIndex,
            reviewVerdict: review.verdict,
            fixVerdict: fix.verdict,
            hasRebuttal: Boolean(fix.rebuttal),
          },
        );

        // --- ARBITER ESCALATION ---
        if (deps.runArbiter !== undefined) {
          this.emit(
            input,
            'plan-review.review.contradiction.escalated',
            'warn',
            `escalating review/fix contradiction to arbiter at iteration ${iterationIndex}`,
            { reason: 'contradiction', iterationIndex },
          );
          const arbiterResult = await deps.runArbiter(ctx, fix);
          if (!arbiterResult.evidence || arbiterResult.evidence.trim().length === 0) {
            this.emit(
              input,
              'plan-review.needs_human_review',
              'warn',
              `arbiter returned empty evidence at iteration ${iterationIndex} — escalating to human`,
              { iterationIndex, outcome: arbiterResult.outcome },
            );
            loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
            deps.loops.update(loop);
            return { outcome: 'needs_human_review', loop, proceedWithConcerns: false };
          }
          if (arbiterResult.outcome === 'finding_invalid') {
            this.emit(
              input,
              'plan-review.review.contradiction.resolved',
              'info',
              `arbiter resolved contradiction at iteration ${iterationIndex}: ${arbiterResult.outcome}`,
              {
                ruling: arbiterResult.outcome,
                resolvedBy: 'contradiction-arbiter',
                evidence: arbiterResult.evidence,
                iterationIndex,
              },
            );
            if (manifestError) {
              loop = completeIteration(loop, {
                outcome: 'unresolved',
                fixInvocationId: fix.invocationId,
                now: deps.now(),
              });
              deps.loops.update(loop);
              this.emit(
                input,
                'plan-review.loop.iteration.completed',
                'info',
                `iteration ${iterationIndex} completed: unresolved (manifest error remains)`,
                { index: iterationIndex, outcome: 'unresolved' },
              );
              continue;
            }
            loop = completeIteration(loop, { outcome: 'resolved', now: deps.now() });
            deps.loops.update(loop);
            return { outcome: 'success', loop, proceedWithConcerns: false };
          }
          if (arbiterResult.outcome === 'finding_valid') {
            this.emit(
              input,
              'plan-review.review.contradiction.resolved',
              'info',
              `arbiter resolved contradiction at iteration ${iterationIndex}: ${arbiterResult.outcome}`,
              { ruling: arbiterResult.outcome, evidence: arbiterResult.evidence, iterationIndex },
            );
            pendingReconciliationContext = arbiterResult.rationale;
            loop = completeIteration(loop, {
              outcome: 'unresolved',
              fixInvocationId: fix.invocationId,
              now: deps.now(),
            });
            deps.loops.update(loop);
            continue;
          }
          this.emit(
            input,
            'plan-review.needs_human_review',
            'warn',
            `arbiter could not resolve contradiction at iteration ${iterationIndex}: ${arbiterResult.outcome}`,
            { ruling: arbiterResult.outcome, evidence: arbiterResult.evidence, iterationIndex },
          );
          loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
          deps.loops.update(loop);
          return { outcome: 'needs_human_review', loop, proceedWithConcerns: false };
        }

        // No arbiter wired — escalate to human.
        this.emit(
          input,
          'plan-review.needs_human_review',
          'warn',
          `contradiction with no arbiter configured at iteration ${iterationIndex}`,
          { iterationIndex },
        );
        loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
        deps.loops.update(loop);
        return { outcome: 'needs_human_review', loop, proceedWithConcerns: false };
      } else if (fix.verdict === 'done_no_fixes_needed' && manifestOnlyFix) {
        this.emit(
          input,
          'plan-review.manifest_mismatch.fixer_declined',
          'warn',
          `fixer declined to address manifest/prose mismatch at iteration ${iterationIndex}; treating as unresolved`,
          { iterationIndex },
        );
        loop = completeIteration(loop, {
          outcome: 'unresolved',
          fixInvocationId: fix.invocationId,
          now: deps.now(),
        });
        deps.loops.update(loop);
        this.emit(
          input,
          'plan-review.loop.iteration.completed',
          'info',
          `iteration ${iterationIndex} completed: unresolved`,
          { index: iterationIndex, outcome: 'unresolved' },
        );
        continue;
      }

      loop = completeIteration(loop, {
        outcome: 'fixed',
        fixInvocationId: fix.invocationId,
        now: deps.now(), // check final review if maxIterations reached
      });
      deps.loops.update(loop);
      this.emit(
        input,
        'plan-review.loop.iteration.completed',
        'info',
        `iteration ${iterationIndex} completed: fixed`,
        { index: iterationIndex, outcome: 'fixed' },
      );

      if (iterationIndex === loop.maxIterations) {
        const finalIterationIndex = iterationIndex + 1;
        const finalCtx: PlanReviewContext = { ...baseCtx, iterationIndex: finalIterationIndex };

        this.emit(
          input,
          'plan-review.loop.final_review',
          'info',
          'Running final review after last fixer pass',
          { iteration: finalIterationIndex },
        );

        // --- REVIEWER (with retry budget per parity #297) ---
        let finalReview: PlanReviewResult | undefined;
        let finalReviewAttempts = 0;
        while (finalReviewAttempts <= reviewerMaxRetries) {
          finalReviewAttempts += 1;
          finalReview = await deps.runReview(finalCtx);
          if (finalReview.agentOutcome === 'success' && finalReview.verdict !== undefined) break;
          if (finalReviewAttempts <= reviewerMaxRetries) {
            this.emit(
              input,
              'plan-review.reviewer.retry',
              'warn',
              `plan-review reviewer attempt ${finalReviewAttempts} failed (invocation ${finalReview.invocationId}), retrying...`,
              {
                attempt: finalReviewAttempts,
                maxAttempts: reviewerMaxRetries + 1,
                agentOutcome: finalReview.agentOutcome,
                hasVerdict: finalReview.verdict !== undefined,
                invocationId: finalReview.invocationId,
              },
            );
          }
        }

        if (
          !finalReview ||
          finalReview.agentOutcome !== 'success' ||
          finalReview.verdict === undefined
        ) {
          this.emit(
            input,
            'plan-review.reviewer.failed',
            'error',
            `reviewer exhausted retry budget at final review pass`,
            { iterationIndex: finalIterationIndex, attempts: finalReviewAttempts },
          );
          loop = {
            ...loop,
            iterations: [
              ...loop.iterations,
              {
                index: finalIterationIndex,
                reviewInvocationId: finalReview?.invocationId ?? '',
                startedAt: deps.now(),
                completedAt: deps.now(),
                outcome: 'failed',
              },
            ],
          };
          loop = exhaust(loop, deps.now());
          deps.loops.update(loop);
          this.emit(
            input,
            'plan-review.loop.iteration.completed',
            'info',
            `iteration ${finalIterationIndex} completed: failed`,
            { index: finalIterationIndex, outcome: 'failed' },
          );
          return { outcome: 'failed', loop, proceedWithConcerns: false };
        }

        const finalManifestError = await deps.checkManifestSync(finalCtx);
        if (finalManifestError) {
          this.emit(
            input,
            'plan-review.manifest_mismatch.detected',
            'warn',
            `plan.md/task-manifest.json mismatch detected at final review pass: ${finalManifestError}`,
            { iterationIndex: finalCtx.iterationIndex, manifestError: finalManifestError },
          );
        }

        if (
          !finalManifestError &&
          (finalReview.verdict === 'pass' || finalReview.verdict === 'p2_only')
        ) {
          const finalIteration: import('@ai-sdlc/domain').LoopIteration = {
            index: finalIterationIndex,
            reviewInvocationId: finalReview.invocationId,
            startedAt: deps.now(),
            completedAt: deps.now(),
            outcome: 'resolved',
          };
          loop = {
            ...loop,
            iterations: [...loop.iterations, finalIteration],
            status: 'converged',
            completedAt: deps.now(),
          };
          deps.loops.update(loop);
          this.emit(
            input,
            'plan-review.loop.iteration.completed',
            'info',
            `iteration ${finalIterationIndex} completed: resolved`,
            { index: finalIterationIndex, outcome: 'resolved' },
          );
          return { outcome: 'success', loop, proceedWithConcerns: false };
        }

        if (!finalManifestError && finalReview.verdict === 'proceed_with_concerns') {
          const finalIteration: import('@ai-sdlc/domain').LoopIteration = {
            index: finalIterationIndex,
            reviewInvocationId: finalReview.invocationId,
            startedAt: deps.now(),
            completedAt: deps.now(),
            outcome: 'resolved',
          };
          loop = {
            ...loop,
            iterations: [...loop.iterations, finalIteration],
            status: 'converged',
            completedAt: deps.now(),
          };
          deps.loops.update(loop);
          this.emit(
            input,
            'plan-review.loop.iteration.completed',
            'info',
            `iteration ${finalIterationIndex} completed: resolved (proceed with concerns)`,
            { index: finalIterationIndex, outcome: 'resolved', knownLimitations: true },
          );
          return {
            outcome: 'success',
            loop,
            proceedWithConcerns: true,
            ...(finalReview.knownLimitations
              ? { knownLimitations: finalReview.knownLimitations }
              : {}),
          };
        }

        if (deps.runFinalReviewArbiter !== undefined) {
          this.emit(
            input,
            'plan-review.final_review.arbiter.escalated',
            'warn',
            `escalating final review fail to arbiter at iteration ${finalIterationIndex}`,
            { reason: 'final_review_fail', iterationIndex: finalIterationIndex },
          );
          const arbiterResult = await deps.runFinalReviewArbiter(finalCtx, finalReview);
          if (!arbiterResult.evidence || arbiterResult.evidence.trim().length === 0) {
            this.emit(
              input,
              'plan-review.needs_human_review',
              'warn',
              `final review arbiter returned empty evidence at iteration ${finalIterationIndex} — escalating to human`,
              { iterationIndex: finalIterationIndex, outcome: arbiterResult.outcome },
            );
            const finalIteration: import('@ai-sdlc/domain').LoopIteration = {
              index: finalIterationIndex,
              reviewInvocationId: finalReview.invocationId,
              startedAt: deps.now(),
              completedAt: deps.now(),
              // 'failed' covers both "fixer failed" and "arbiter returned empty evidence"
              // (G1 guardrail). Consumers should use the iteration event metadata to
              // distinguish the two when needed.
              outcome: 'failed',
            };
            loop = {
              ...loop,
              iterations: [...loop.iterations, finalIteration],
            };
            this.emit(
              input,
              'plan-review.loop.iteration.completed',
              'info',
              `iteration ${finalIterationIndex} completed: failed`,
              { index: finalIterationIndex, outcome: 'failed' },
            );
            loop = exhaust(loop, deps.now());
            deps.loops.update(loop);
            return { outcome: 'needs_human_review', loop, proceedWithConcerns: false };
          }
          if (arbiterResult.outcome === 'finding_invalid') {
            if (finalManifestError) {
              // emit resolved final review fail but manifest mismatch remains
              // do NOT return success; fall through to the unresolved fallback below
              this.emit(
                input,
                'plan-review.final_review.arbiter.resolved',
                'info',
                `arbiter resolved final review fail at iteration ${finalIterationIndex}: ${arbiterResult.outcome} (but manifest mismatch remains)`,
                {
                  ruling: arbiterResult.outcome,
                  resolvedBy: 'final-review-arbiter',
                  evidence: arbiterResult.evidence,
                  iterationIndex: finalIterationIndex,
                  manifestError: finalManifestError,
                },
              );
            } else {
              this.emit(
                input,
                'plan-review.final_review.arbiter.resolved',
                'info',
                `arbiter resolved final review fail at iteration ${finalIterationIndex}: ${arbiterResult.outcome}`,
                {
                  ruling: arbiterResult.outcome,
                  resolvedBy: 'final-review-arbiter',
                  evidence: arbiterResult.evidence,
                  iterationIndex: finalIterationIndex,
                },
              );
              const finalIteration: import('@ai-sdlc/domain').LoopIteration = {
                index: finalIterationIndex,
                reviewInvocationId: finalReview.invocationId,
                startedAt: deps.now(),
                completedAt: deps.now(),
                outcome: 'resolved',
              };
              loop = {
                ...loop,
                iterations: [...loop.iterations, finalIteration],
                status: 'converged',
                completedAt: deps.now(),
              };
              deps.loops.update(loop);
              this.emit(
                input,
                'plan-review.loop.iteration.completed',
                'info',
                `iteration ${finalIterationIndex} completed: resolved`,
                {
                  index: finalIterationIndex,
                  outcome: 'resolved',
                  resolvedBy: 'final-review-arbiter',
                },
              );
              return {
                outcome: 'success',
                loop,
                proceedWithConcerns: false,
                ...(finalReview.knownLimitations
                  ? { knownLimitations: finalReview.knownLimitations }
                  : {}),
              };
            }
          } else {
            this.emit(
              input,
              'plan-review.final_review.arbiter.resolved',
              'info',
              `arbiter could not resolve final review fail at iteration ${finalIterationIndex}: ${arbiterResult.outcome}`,
              {
                ruling: arbiterResult.outcome,
                evidence: arbiterResult.evidence,
                iterationIndex: finalIterationIndex,
              },
            );
          }
        }

        const finalIteration: import('@ai-sdlc/domain').LoopIteration = {
          index: finalIterationIndex,
          reviewInvocationId: finalReview.invocationId,
          startedAt: deps.now(),
          completedAt: deps.now(),
          outcome: 'unresolved',
        };
        loop = {
          ...loop,
          iterations: [...loop.iterations, finalIteration],
        };
        deps.loops.update(loop);
        this.emit(
          input,
          'plan-review.loop.iteration.completed',
          'info',
          `iteration ${finalIterationIndex} completed: unresolved`,
          { index: finalIterationIndex, outcome: 'unresolved' },
        );
      }
    }

    loop = exhaust(loop, deps.now());
    deps.loops.update(loop);
    this.emit(
      input,
      'plan-review.loop.exhausted',
      'error',
      `plan-review loop exhausted after ${loop.iterations.length} iterations`,
      { iterations: loop.iterations.length, maxIterations: loop.maxIterations },
    );
    return { outcome: 'needs_human_review', loop, proceedWithConcerns: false };
  }

  private emit(
    input: PlanReviewLoopInput,
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
}
