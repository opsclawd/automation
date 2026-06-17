import type { PhaseName, Failure } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../handler.js';
import { createEventEmitter } from '../handler.js';

export interface ReviewFixHandlerOpts {
  /** Runs the M7 ReviewFixLoop and returns its terminal phase outcome.
   *  Injected so this handler is testable; the executor wires the
   *  real ReviewFixLoop.execute(...) here. */
  runLoop: (ctx: PhaseHandlerContext) => Promise<{
    phaseOutcome: 'passed' | 'failed';
    loopStatus: 'converged' | 'failed' | 'exhausted';
  }>;
}

export class ReviewFixHandler implements PhaseHandler {
  readonly phase = 'review-fix' as PhaseName;
  constructor(private readonly opts: ReviewFixHandlerOpts) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);
    emit('phase.started', 'info', 'review-fix started');

    let phaseOutcome: 'passed' | 'failed';
    let loopStatus: 'converged' | 'failed' | 'exhausted';
    try {
      const result = await this.opts.runLoop(ctx);
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
      emit('phase.failed', 'error', message);
      return { outcome: 'failed', failure };
    }

    if (phaseOutcome === 'passed') {
      emit('phase.completed', 'info', 'review-fix converged');
      return { outcome: 'passed' };
    }
    const terminalStatus: 'exhausted' | 'failed' =
      loopStatus === 'exhausted' ? 'exhausted' : 'failed';
    const verboseMessage =
      terminalStatus === 'exhausted'
        ? 'review/fix loop exhausted without converging'
        : 'review/fix loop failed';
    const eventMessage =
      terminalStatus === 'exhausted' ? 'review-fix loop exhausted' : 'review-fix loop failed';
    emit('phase.failed', 'error', eventMessage);
    return {
      outcome: 'failed',
      failure: {
        runUuid: ctx.runUuid,
        phase: 'review-fix',
        kind: 'validation_failed',
        message: verboseMessage,
        canRetry: true,
        suggestedAction:
          'Inspect the latest review.md and loop iterations, then resume or intervene.',
        artifacts: ['review.md'],
        detectedAt: ctx.now(),
      },
    };
  }
}
