import { PhaseName } from '@ai-sdlc/domain';
import type { RunStatus, Failure } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../handler.js';

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
  readyMaxDays: number;
}

export class PostPrReviewHandler implements PhaseHandler {
  readonly phase = PhaseName('post-pr-review');

  constructor(private readonly opts: PostPrReviewHandlerOpts) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    this._emitPhase(ctx, 'phase.started', 'info', 'post-pr-review started');

    const { signal } = await this.opts.runPoll(ctx);

    switch (signal) {
      case 'merged':
        this.opts.setRunStatus('passed');
        this._emitRun(ctx, 'run.completed', 'info', 'PR merged — run complete');
        return { outcome: 'passed' };

      case 'all_resolved':
        this.opts.setRunStatus('waiting');
        this._emitRun(ctx, 'run.ready', 'info', 'all reviews addressed — awaiting merge');
        return { outcome: 'passed' };

      case 'pending':
        this._emitPhase(ctx, 'post-pr-review.poll.pending', 'info', 'reviews still pending');
        return { outcome: 'passed' };

      case 'timed_out':
        this.opts.setRunStatus('cancelled');
        this._emitRun(ctx, 'run.cancelled_timeout', 'warn', 'ready timeout exceeded');
        return { outcome: 'passed' };

      case 'cancelled':
        this.opts.setRunStatus('cancelled');
        this._emitRun(ctx, 'run.cancelled', 'info', 'PR review cancelled');
        return { outcome: 'passed' };

      case 'max_polls':
        this.opts.setRunStatus('failed');
        this._emitRun(ctx, 'run.failed', 'error', 'max poll attempts exceeded');
        return {
          outcome: 'failed',
          failure: this._failure(ctx, 'max poll attempts exceeded', 'max_polls'),
        };

      case 'blocked':
        this.opts.setRunStatus('blocked');
        this._emitRun(ctx, 'run.blocked', 'warn', 'PR review blocked');
        return {
          outcome: 'blocked',
          failure: this._failure(ctx, 'PR review blocked', 'blocked'),
        };

      default:
        return {
          outcome: 'failed',
          failure: this._failure(ctx, `unknown poll signal: ${signal}`, signal),
        };
    }
  }

  private _emitPhase(
    ctx: PhaseHandlerContext,
    type: string,
    level: 'info' | 'warn' | 'error',
    message: string,
  ): void {
    ctx.events.publish(ctx.runUuid, {
      runId: ctx.runId,
      phase: this.phase,
      level,
      type,
      message,
      timestamp: ctx.now().toISOString(),
      metadata: {},
    });
  }

  private _emitRun(
    ctx: PhaseHandlerContext,
    type: string,
    level: 'info' | 'warn' | 'error',
    message: string,
  ): void {
    ctx.events.publish(ctx.runUuid, {
      runId: ctx.runId,
      level,
      type,
      message,
      timestamp: ctx.now().toISOString(),
      metadata: {},
    });
  }

  private _failure(ctx: PhaseHandlerContext, message: string, signal: string): Failure {
    return {
      runUuid: ctx.runUuid,
      phase: this.phase,
      kind: 'polling_failed',
      message,
      canRetry: false,
      suggestedAction: `Poll returned signal '${signal}'. Check the PR review poller logs.`,
      artifacts: [],
      detectedAt: ctx.now(),
    };
  }
}
