import { PhaseName, type Failure, type FailureKind } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult, EventEmitter } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import { ArtifactNotFoundError } from '../../ports/artifact-store.js';

export interface WaitMergeHandlerOpts {
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export class WaitMergeHandler implements PhaseHandler {
  readonly phase = PhaseName('wait-merge');

  constructor(private readonly opts: WaitMergeHandlerOpts = {}) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);
    emit('wait_merge.started', 'info', 'waiting for PR merge and CI completion', {
      policy: ctx.executionPolicy,
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

    // 2. Query GitHub PR and CI merge readiness status
    try {
      const readiness = await ctx.github.getPrMergeReadiness(ctx.repoFullName, prNumber);

      if (readiness.isMerged || readiness.state === 'merged') {
        emit('wait_merge.completed', 'info', `PR #${prNumber} is merged`, {
          prNumber,
          prUrl,
          state: 'merged',
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

      // If PR is open and CI is pending or awaiting merge
      emit('wait_merge.waiting', 'info', `PR #${prNumber} is open; awaiting CI checks and merge`, {
        prNumber,
        prUrl,
        state: 'open',
        ciStatus: readiness.ciStatus,
        mergeStateStatus: readiness.mergeStateStatus,
      });
      return { outcome: 'resting' };
    } catch (err) {
      const message = `Failed to query PR #${prNumber} merge readiness: ${err instanceof Error ? err.message : String(err)}`;
      return this.fail(ctx, emit, 'github_failed', message);
    }
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
