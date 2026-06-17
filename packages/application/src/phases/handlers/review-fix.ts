import type { PhaseName } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../handler.js';

export interface ReviewFixHandlerOpts {
  /** Runs the M7 ReviewFixLoop and returns its terminal phase outcome.
   *  Injected so this handler is testable; the executor wires the
   *  real ReviewFixLoop.execute(...) here. */
  runLoop: (ctx: PhaseHandlerContext) => Promise<{ phaseOutcome: 'passed' | 'failed' }>;
}

export class ReviewFixHandler implements PhaseHandler {
  readonly phase = 'review-fix' as PhaseName;
  constructor(private readonly opts: ReviewFixHandlerOpts) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    this.emit(ctx, 'phase.started', 'info', 'review-fix started');
    const { phaseOutcome } = await this.opts.runLoop(ctx);
    if (phaseOutcome === 'passed') {
      this.emit(ctx, 'phase.completed', 'info', 'review-fix converged');
      return { outcome: 'passed' };
    }
    this.emit(ctx, 'phase.failed', 'error', 'review-fix loop exhausted');
    return {
      outcome: 'failed',
      failure: {
        runUuid: ctx.runUuid,
        phase: 'review-fix',
        kind: 'validation_failed',
        message: 'review/fix loop exhausted without converging',
        canRetry: true,
        suggestedAction:
          'Inspect the latest review.md and loop iterations, then resume or intervene.',
        artifacts: ['review.md'],
        detectedAt: ctx.now(),
      },
    };
  }

  private emit(
    ctx: PhaseHandlerContext,
    type: string,
    level: 'info' | 'warn' | 'error',
    message: string,
  ): void {
    ctx.events.publish(ctx.runUuid, {
      runId: ctx.runUuid,
      phase: 'review-fix',
      level,
      type,
      message,
      timestamp: ctx.now().toISOString(),
      metadata: {},
    });
  }
}
