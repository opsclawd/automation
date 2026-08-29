import { PhaseName, type Failure, type FailureKind } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult, EventEmitter } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import { ArtifactNotFoundError } from '../../ports/artifact-store.js';

export interface WaitMergeHandlerOpts {
  /** Number of readiness checks to run in-process before parking as resting. Defaults to 1 (single check, no polling). */
  maxPolls?: number;
  /** Milliseconds to sleep between checks when maxPolls > 1. */
  pollIntervalMs?: number;
  /** Injectable for tests; defaults to a real timer-based sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class WaitMergeHandler implements PhaseHandler {
  readonly phase = PhaseName('wait-merge');
  private readonly maxPolls: number;
  private readonly pollIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: WaitMergeHandlerOpts = {}) {
    this.maxPolls = opts.maxPolls ?? 1;
    this.pollIntervalMs = opts.pollIntervalMs ?? 60_000;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);
    emit('wait_merge.started', 'info', 'waiting for PR merge and CI completion', {
      policy: ctx.executionPolicy,
      maxPolls: this.maxPolls,
    });

    // 1. Read pr-url.txt
    let prUrl: string;
    try {
      prUrl = (await ctx.artifacts.read(ctx.runUuid, 'pr-url.txt')).trim();
    } catch (e) {
      const message =
        e instanceof ArtifactNotFoundError
          ? 'pr-url.txt not found in artifact store'
          : `Failed to read pr-url.txt: ${e instanceof Error ? e.message : String(e)}`;
      return this.fail(ctx, emit, 'missing_artifact', message);
    }

    const prNumber = this.parsePrNumber(prUrl);
    if (prNumber === undefined) {
      return this.fail(ctx, emit, 'github_failed', `invalid pr-url.txt format: '${prUrl}'`);
    }

    // 2. Bounded in-process poll loop: check readiness, and if still pending,
    // sleep and re-check rather than parking on the very first pending
    // result. Mirrors legacy post-pr-review's bounded poller, minus the
    // comment-tracking machinery this phase doesn't need.
    for (let pollNumber = 1; pollNumber <= this.maxPolls; pollNumber++) {
      try {
        const readiness = await ctx.github.getPrMergeReadiness(ctx.repoFullName, prNumber);

        if (readiness.isMerged || readiness.state === 'merged') {
          emit('wait_merge.completed', 'info', `PR #${prNumber} is merged`, {
            prNumber,
            prUrl,
            state: 'merged',
            pollNumber,
          });
          return { outcome: 'passed' };
        }

        if (readiness.state === 'closed') {
          const message = `PR #${prNumber} was closed without being merged`;
          emit('wait_merge.failed', 'error', message, { prNumber, prUrl, state: 'closed' });
          return {
            outcome: 'failed',
            failure: {
              runUuid: ctx.runUuid,
              phase: this.phase,
              kind: 'github_failed',
              message,
              canRetry: false,
              suggestedAction: 'Re-open or recreate the pull request.',
              artifacts: ['pr-url.txt'],
              detectedAt: ctx.now(),
            },
          };
        }

        if (readiness.ciStatus === 'failed' || readiness.mergeStateStatus === 'dirty') {
          const message = `PR #${prNumber} CI checks or merge requirements failed: ${readiness.details ?? 'check status failed'}`;
          emit('wait_merge.ci_failed', 'error', message, {
            prNumber,
            prUrl,
            ciStatus: readiness.ciStatus,
            mergeStateStatus: readiness.mergeStateStatus,
          });
          return {
            outcome: 'failed',
            failure: {
              runUuid: ctx.runUuid,
              phase: this.phase,
              kind: 'command_failed',
              message,
              canRetry: false,
              suggestedAction: 'Check GitHub Actions / CI logs and fix failing checks.',
              artifacts: ['pr-url.txt'],
              detectedAt: ctx.now(),
            },
          };
        }

        // PR open, CI pending or awaiting merge.
        emit(
          'wait_merge.waiting',
          'info',
          `PR #${prNumber} is open; awaiting CI checks and merge`,
          {
            prNumber,
            prUrl,
            state: 'open',
            ciStatus: readiness.ciStatus,
            mergeStateStatus: readiness.mergeStateStatus,
            pollNumber,
          },
        );
      } catch (err) {
        const message = `Failed to query PR #${prNumber} merge readiness: ${err instanceof Error ? err.message : String(err)}`;
        return this.fail(ctx, emit, 'github_failed', message);
      }

      if (pollNumber < this.maxPolls) {
        await this.sleep(this.pollIntervalMs);
      }
    }

    return { outcome: 'resting' };
  }

  private parsePrNumber(prUrl: string): number | undefined {
    try {
      const parsed = new URL(prUrl);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
      const match = parsed.pathname.match(/\/pull\/([1-9]\d*)\/?$/);
      return match ? Number(match[1]) : undefined;
    } catch {
      return undefined;
    }
  }

  private fail(
    ctx: PhaseHandlerContext,
    emit: EventEmitter,
    kind: FailureKind,
    message: string,
  ): PhaseResult {
    const failure: Failure = {
      runUuid: ctx.runUuid,
      phase: this.phase as string,
      kind,
      message,
      canRetry: false,
      suggestedAction: 'Check pull request and GitHub permissions.',
      artifacts: ['pr-url.txt'],
      detectedAt: ctx.now(),
    };
    emit('wait_merge.failed', 'error', message);
    return { outcome: 'failed', failure };
  }
}
