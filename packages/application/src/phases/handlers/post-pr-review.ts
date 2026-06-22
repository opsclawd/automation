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
  | 'max_polls_reached'
  | 'blocked';

export interface PostPrReviewHandlerOpts {
  runPoll: (ctx: PhaseHandlerContext) => Promise<{ signal: PollSignal }>;
  setRunStatus: (runUuid: string, status: RunStatus) => void;
}

export class PostPrReviewHandler implements PhaseHandler {
  readonly phase = PhaseName('post-pr-review');

  constructor(private readonly opts: PostPrReviewHandlerOpts) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);
    emit('post_pr_review.started', 'info', 'post-pr-review started');

    const { signal } = await this.opts.runPoll(ctx);

    switch (signal) {
      case 'merged':
        this.opts.setRunStatus(ctx.runUuid, 'passed');
        emit('post_pr_review.completed', 'info', 'PR merged — phase complete', {
          signal: 'merged',
        });
        return { outcome: 'passed' };

      case 'all_resolved':
        this.opts.setRunStatus(ctx.runUuid, 'waiting');
        this._emitRun(ctx, 'run.ready', 'info', 'all reviews addressed — awaiting merge', {
          signal: 'all_resolved',
        });
        emit('post_pr_review.completed', 'info', 'all reviews resolved — phase resting', {
          signal: 'all_resolved',
        });
        return { outcome: 'resting' };

      case 'pending':
        emit('post-pr-review.poll.pending', 'info', 'reviews still pending', { signal: 'pending' });
        return { outcome: 'resting' };

      case 'timed_out':
        this.opts.setRunStatus(ctx.runUuid, 'cancelled');
        this._emitRun(ctx, 'run.cancelled_timeout', 'warn', 'ready timeout exceeded', {
          signal: 'timed_out',
        });
        emit('post_pr_review.completed', 'info', 'timeout — phase resting', {
          signal: 'timed_out',
        });
        return { outcome: 'resting' };

      case 'cancelled':
        this.opts.setRunStatus(ctx.runUuid, 'cancelled');
        this._emitRun(ctx, 'run.cancelled', 'info', 'PR review cancelled', { signal: 'cancelled' });
        emit('post_pr_review.completed', 'info', 'PR review cancelled — phase resting', {
          signal: 'cancelled',
        });
        return { outcome: 'resting' };

      case 'max_polls_reached':
        this.opts.setRunStatus(ctx.runUuid, 'waiting');
        this._emitRun(ctx, 'run.ready', 'info', 'max poll attempts reached — run waiting', {
          signal: 'max_polls_reached',
        });
        emit('post_pr_review.completed', 'info', 'max poll attempts reached — phase resting', {
          signal: 'max_polls_reached',
        });
        return { outcome: 'resting' };

      case 'blocked':
        this.opts.setRunStatus(ctx.runUuid, 'waiting');
        this._emitRun(ctx, 'run.blocked', 'warn', 'PR review blocked', { signal: 'blocked' });
        emit('post_pr_review.completed', 'info', 'PR review blocked — phase resting', {
          signal: 'blocked',
        });
        return { outcome: 'resting' };

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
