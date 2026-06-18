import { PhaseName } from '@ai-sdlc/domain';
import type { RunStatus } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../handler.js';
import { createEventEmitter } from '../handler.js';

export type PollSignal =
  | 'all_resolved'
  | 'merged'
  | 'pending'
  | 'timed_out'
  | 'cancelled'
  | 'max_polls'
  | 'blocked';

export interface PostPrReviewHandlerOpts {
  runPoll: (ctx: PhaseHandlerContext) => Promise<{ signal: PollSignal }>;
  setRunStatus: (status: RunStatus) => void;
}

export class PostPrReviewHandler implements PhaseHandler {
  readonly phase = PhaseName('post-pr-review');

  constructor(private readonly opts: PostPrReviewHandlerOpts) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);
    emit('phase.started', 'info', 'post-pr-review started');

    const { signal } = await this.opts.runPoll(ctx);

    switch (signal) {
      case 'merged':
        this.opts.setRunStatus('passed');
        this._emitRun(ctx, 'run.completed', 'info', 'PR merged — run complete', {
          signal: 'merged',
        });
        emit('phase.completed', 'info', 'PR merged — phase complete', { signal: 'merged' });
        return { outcome: 'passed' };

      case 'all_resolved':
        this.opts.setRunStatus('waiting');
        this._emitRun(ctx, 'run.ready', 'info', 'all reviews addressed — awaiting merge', {
          signal: 'all_resolved',
        });
        emit('phase.completed', 'info', 'all reviews resolved — phase complete', {
          signal: 'all_resolved',
        });
        return { outcome: 'passed' };

      case 'pending':
        emit('post-pr-review.poll.pending', 'info', 'reviews still pending', { signal: 'pending' });
        return { outcome: 'passed' };

      case 'timed_out':
        this.opts.setRunStatus('cancelled');
        this._emitRun(ctx, 'run.cancelled_timeout', 'warn', 'ready timeout exceeded', {
          signal: 'timed_out',
        });
        emit('phase.completed', 'info', 'timeout — phase complete', { signal: 'timed_out' });
        return { outcome: 'passed' };

      case 'cancelled':
        this.opts.setRunStatus('cancelled');
        this._emitRun(ctx, 'run.cancelled', 'info', 'PR review cancelled', { signal: 'cancelled' });
        emit('phase.completed', 'info', 'PR review cancelled — phase complete', {
          signal: 'cancelled',
        });
        return { outcome: 'passed' };

      case 'max_polls':
        this.opts.setRunStatus('failed');
        this._emitRun(ctx, 'run.failed', 'error', 'max poll attempts exceeded', {
          signal: 'max_polls',
        });
        emit('phase.failed', 'error', 'max poll attempts exceeded — phase failed', {
          signal: 'max_polls',
        });
        return this._fail(ctx, 'max poll attempts exceeded', 'max_polls');

      case 'blocked':
        this.opts.setRunStatus('blocked');
        this._emitRun(ctx, 'run.blocked', 'warn', 'PR review blocked', { signal: 'blocked' });
        emit('phase.failed', 'error', 'PR review blocked — phase failed', { signal: 'blocked' });
        return this._fail(ctx, 'PR review blocked', 'blocked', 'blocked');

      default:
        return this._fail(ctx, `unknown poll signal: ${signal}`, signal);
    }
  }

  private _emitRun(
    ctx: PhaseHandlerContext,
    type: string,
    level: 'info' | 'warn' | 'error',
    message: string,
    metadata: Record<string, unknown> = {},
  ): void {
    ctx.events.publish(ctx.runUuid, {
      runId: ctx.runId,
      level,
      type,
      message,
      timestamp: ctx.now().toISOString(),
      metadata,
    });
  }

  private _fail(
    ctx: PhaseHandlerContext,
    message: string,
    signal: string,
    outcome: 'failed' | 'blocked' = 'failed',
  ): PhaseResult {
    return {
      outcome,
      failure: {
        runUuid: ctx.runUuid,
        phase: this.phase,
        kind: 'polling_failed',
        message,
        canRetry: false,
        suggestedAction: `Poll returned signal '${signal}'. Check the PR review poller logs.`,
        artifacts: [],
        detectedAt: ctx.now(),
      },
    };
  }
}
