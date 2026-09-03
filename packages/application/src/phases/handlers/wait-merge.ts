import { PhaseName, type Failure, type FailureKind } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult, EventEmitter } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import { ArtifactNotFoundError } from '../../ports/artifact-store.js';

export interface WaitMergeHandlerOpts {
  /** Number of readiness checks to run in-process before parking as resting. Defaults to 1 (single check, no polling). */
  maxPolls?: number;
  /** Milliseconds to sleep between checks after the first. */
  pollIntervalMs?: number;
  /**
   * Milliseconds to sleep before the very first check. CI typically takes
   * several minutes to even start reporting, so an immediate first check is
   * usually wasted; defaults to pollIntervalMs (no distinct initial delay).
   */
  initialDelayMs?: number;
  /** Injectable for tests; defaults to a real timer-based sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class WaitMergeHandler implements PhaseHandler {
  readonly phase = PhaseName('wait-merge');
  private readonly maxPolls: number;
  private readonly pollIntervalMs: number;
  private readonly initialDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: WaitMergeHandlerOpts = {}) {
    this.maxPolls = opts.maxPolls ?? 1;
    this.pollIntervalMs = opts.pollIntervalMs ?? 60_000;
    this.initialDelayMs = opts.initialDelayMs ?? this.pollIntervalMs;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);

    // A prior invocation of this phase for the same run parks as 'resting'
    // (outcome: 'resting') when its bounded poll window elapses without a
    // resolution — the process exits normally and expects to be resumed
    // later, whether by a scheduler or by the orphan-recovery sweep picking
    // up a run whose recorded pid is no longer alive (which looks
    // indistinguishable from a crash at the DB level). Without this marker,
    // every such resumed entry re-applies the full initialDelayMs blind
    // wait (10 minutes by default) before its first check, even though real
    // wall-clock time has already passed and the PR may already be merged
    // — repeatedly starving whatever else is waiting on this repo's single
    // worker lease. A resumed entry checks immediately instead.
    const RESUME_MARKER_PATH = 'wait-merge-attempted.marker';
    let isResumedAttempt = false;
    try {
      await ctx.artifacts.read(ctx.runUuid, RESUME_MARKER_PATH);
      isResumedAttempt = true;
    } catch {
      // No marker yet: this is the first entry into wait-merge for this run.
    }
    if (!isResumedAttempt) {
      try {
        await ctx.artifacts.write({
          runId: ctx.runUuid,
          phaseId: this.phase,
          relativePath: RESUME_MARKER_PATH,
          contents: ctx.now().toISOString(),
        });
      } catch {
        // Best-effort: if this write fails, the worst case is a resumed
        // entry re-applying one more initial delay, not a correctness bug.
      }
    }

    emit('wait_merge.started', 'info', 'waiting for PR merge and CI completion', {
      policy: ctx.executionPolicy,
      maxPolls: this.maxPolls,
      resumedAttempt: isResumedAttempt,
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
    // comment-tracking machinery this phase doesn't need. The first check is
    // delayed by initialDelayMs (CI typically takes several minutes to even
    // start reporting), then subsequent checks use the shorter pollIntervalMs.
    // A resumed attempt (see marker check above) skips this delay entirely.
    if (this.maxPolls > 1 && this.initialDelayMs > 0 && !isResumedAttempt) {
      await this.sleep(this.initialDelayMs);
    }

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
