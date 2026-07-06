import type { PhaseName, Failure } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../handler.js';
import { createEventEmitter } from '../handler.js';

export interface ReviewFixHandlerOpts {
  /** Runs the M7 ReviewFixLoop and returns its terminal phase outcome.
   *  Injected so this handler is testable; the executor wires the
   *  real ReviewFixLoop.execute(...) here. */
  runLoop: (ctx: PhaseHandlerContext) => Promise<{
    phaseOutcome: 'passed' | 'failed';
    loopStatus: 'converged' | 'converged_with_notes' | 'failed' | 'exhausted';
    /** True when the loop short-circuited via the unfounded_pingpong path. */
    needsHumanReview?: boolean;
  }>;
}

export class ReviewFixHandler implements PhaseHandler {
  readonly phase = 'review-fix' as PhaseName;
  constructor(private readonly opts: ReviewFixHandlerOpts) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);
    emit('review_fix.started', 'info', 'review-fix started');

    let phaseOutcome: 'passed' | 'failed';
    let loopStatus: 'converged' | 'converged_with_notes' | 'failed' | 'exhausted';
    let result: Awaited<ReturnType<ReviewFixHandlerOpts['runLoop']>>;
    try {
      result = await this.opts.runLoop(ctx);
      phaseOutcome = result.phaseOutcome;
      loopStatus = result.loopStatus;
    } catch (e) {
      const message = `review/fix loop threw: ${e instanceof Error ? e.message : String(e)}`;
      const failure: Failure = {
        runUuid: ctx.runUuid,
        phase: 'review-fix',
        kind: 'unknown',
        message,
        canRetry: true,
        suggestedAction:
          'Inspect the latest review.md and loop iterations, then resume or intervene.',
        artifacts: ['review.md'],
        detectedAt: ctx.now(),
      };
      emit('review_fix.failed', 'error', message);
      return { outcome: 'failed', failure };
    }

    if (phaseOutcome === 'passed') {
      emit('review_fix.completed', 'info', 'review-fix converged');
      return { outcome: 'passed' };
    }
    const terminalStatus: 'exhausted' | 'failed' =
      loopStatus === 'exhausted' ? 'exhausted' : 'failed';
    const isHumanReview = result.needsHumanReview === true;
    const verboseMessage = isHumanReview
      ? 'review/fix loop short-circuited to needs_human_review (unfounded reviewer findings)'
      : terminalStatus === 'exhausted'
        ? 'review/fix loop exhausted without converging'
        : 'review/fix loop failed';
    const eventMessage = isHumanReview
      ? 'review-fix loop needs human review'
      : terminalStatus === 'exhausted'
        ? 'review-fix loop exhausted'
        : 'review-fix loop failed';
    emit('review_fix.failed', 'error', eventMessage);
    return {
      outcome: isHumanReview ? 'needs_human_review' : 'failed',
      failure: {
        runUuid: ctx.runUuid,
        phase: 'review-fix',
        kind: isHumanReview ? 'needs_human_review' : 'validation_failed',
        message: verboseMessage,
        canRetry: true,
        suggestedAction: isHumanReview
          ? 'Inspect code-review.md (rebuttal appended) and the latest review.md, then resume or intervene.'
          : 'Inspect the latest review.md and loop iterations, then resume or intervene.',
        artifacts: ['review.md', 'code-review.md'],
        detectedAt: ctx.now(),
      },
    };
  }
}
