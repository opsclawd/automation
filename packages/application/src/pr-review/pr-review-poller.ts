import type { RunId, RepositoryId, PhaseName, PollAttempt } from '@ai-sdlc/domain';
import type { EventBusPort } from '../ports/event-bus-port.js';
import type { PrReviewRepositoryPort } from '../ports/pr-review-repository-port.js';
import { DEFAULT_FIRST_REVIEW_GRACE_WINDOW_SECONDS } from '@ai-sdlc/shared';

export interface PollPassResult {
  outcome: string;
  processed: number;
  blocked: number;
  allResolved: boolean;
  rateLimited: boolean;
}

export interface PrReviewPollerDeps {
  prReviewRepo: PrReviewRepositoryPort;
  processOnePass: (input: {
    runId: RunId;
    repoId: RepositoryId;
    repoFullName: string;
    prNumber: number;
    cwd: string;
    phaseId: PhaseName;
    pollNumber: number;
  }) => Promise<{ result: PollPassResult; attempt: PollAttempt | undefined }>;
  eventBus: EventBusPort;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  maxPolls: number;
  pollIntervalMs: number;
  readyMaxDays: number;
  phaseStartedAt: Date;
  recordTerminalState: (
    attempt: PollAttempt | undefined,
    state: PollerTerminalState | 'running',
    nextPollAt?: Date,
  ) => Promise<void>;
  quietPollsThreshold?: number; // default 3; consecutive quiet polls before early exit
  /**
   * Maximum ms the poller keeps polling an empty PR (zero comments ever
   * observed for this run) before allowing the quiet-poll counter to
   * advance. Defaults to DEFAULT_FIRST_REVIEW_GRACE_WINDOW_SECONDS * 1000
   * (30 min). Only applies when no reviewer has yet commented; once any
   * comment is observed, normal quiet-poll accounting takes over.
   */
  firstReviewGraceWindowMs?: number;
  /** Called when a poll resolves all comments (or only blocked remain with nothing in-flight).
   *  Receives the poller input for context. Returns the reactivation action.
   *  Defaults to undefined → returns all_resolved immediately (backward compat). */
  onAllResolved?: (input: PrReviewPollerInput) => Promise<'reactivate' | 'stay_ready' | 'timeout'>;
  /** Maximum reactivation cycles within one poller invocation. */
  maxReactivations?: number;
  /** Called when enterReadyLoop exits after at least one reactivation. Reverts the run
   *  from running back to waiting so the run does not remain stuck as running when the
   *  poller exits with a resting state. */
  revertRunStatus?: (runId: RunId) => Promise<void>;
}

export interface PrReviewPollerInput {
  runId: RunId;
  repoId: RepositoryId;
  repoFullName: string;
  prNumber: number;
  cwd: string;
  phaseId: PhaseName;
}

export type PollerTerminalState =
  | 'all_resolved'
  | 'max_polls_reached'
  | 'blocked'
  | 'timed_out'
  | 'cancelled';

export interface PrReviewPollerResult {
  terminalState: PollerTerminalState;
  pollsRun: number;
}

const RATE_LIMIT_BACKOFF_MS = 60_000;
const MAX_EXCEPTION_RETRIES = 3;

export class PrReviewPoller {
  constructor(private readonly deps: PrReviewPollerDeps) {}

  async run(input: PrReviewPollerInput): Promise<PrReviewPollerResult> {
    const d = this.deps;
    const DAY_MS = 24 * 60 * 60 * 1000;
    const deadline = new Date(d.phaseStartedAt.getTime() + d.readyMaxDays * DAY_MS);
    const existingAttempts = d.prReviewRepo.listPollAttempts(input.runId);
    const graceWindowMs =
      d.firstReviewGraceWindowMs ?? DEFAULT_FIRST_REVIEW_GRACE_WINDOW_SECONDS * 1000;
    const firstReviewDeadline = new Date(d.phaseStartedAt.getTime() + graceWindowMs);
    const meaningfulAttempts = existingAttempts.filter((a) => a.status !== 'rate_limited');
    let pollsRun = meaningfulAttempts.length;
    let lastAttempt: PollAttempt | undefined =
      meaningfulAttempts.length > 0 ? meaningfulAttempts[meaningfulAttempts.length - 1] : undefined;
    let consecutiveFailures = 0;
    let allResolvedEmitted = false;
    let consecutiveQuietPolls = 0;

    // Bug B: on re-entry, ensure at least one new pass even if existing attempts >= maxPolls
    const effectiveMaxPolls = Math.max(d.maxPolls, meaningfulAttempts.length + 1);

    for (
      let pollNumber = meaningfulAttempts.length + 1;
      pollNumber <= effectiveMaxPolls;
      pollNumber++
    ) {
      if (d.now() >= deadline) {
        this.emit(input, 'post-pr-review.poll.timed_out', 'warn', { pollNumber });
        const result = { terminalState: 'timed_out' as const, pollsRun };
        await d.recordTerminalState(lastAttempt, result.terminalState);
        return result;
      }

      this.emit(input, 'post-pr-review.poll.started', 'info', { pollNumber });
      let pass: PollPassResult;
      let attempt: PollAttempt | undefined;
      try {
        ({ result: pass, attempt } = await d.processOnePass({ ...input, pollNumber }));
      } catch (err) {
        consecutiveFailures++;
        this.emit(input, 'post-pr-review.poll.failed', 'warn', {
          pollNumber,
          consecutiveFailures,
          error: err instanceof Error ? err.message : String(err),
        });
        if (consecutiveFailures >= MAX_EXCEPTION_RETRIES) {
          this.emit(input, 'post-pr-review.poll.max_retries_reached', 'warn', {
            pollNumber,
            consecutiveFailures,
          });
          if (d.now() >= deadline) {
            this.emit(input, 'post-pr-review.poll.timed_out', 'warn', { pollNumber });
            const result = { terminalState: 'timed_out' as const, pollsRun };
            await d.recordTerminalState(lastAttempt, result.terminalState);
            return result;
          }
          const result = { terminalState: 'max_polls_reached' as const, pollsRun };
          await d.recordTerminalState(lastAttempt, result.terminalState);
          return result;
        }
        await this.cappedSleep(RATE_LIMIT_BACKOFF_MS, deadline);
        pollNumber--;
        continue;
      }
      if (attempt) lastAttempt = attempt;
      consecutiveFailures = 0;

      if (pass.rateLimited) {
        this.emit(input, 'post-pr-review.poll.rate_limited', 'warn', {
          pollNumber,
          backoffMs: RATE_LIMIT_BACKOFF_MS,
        });
        await this.cappedSleep(RATE_LIMIT_BACKOFF_MS, deadline);
        pollNumber--;
        continue;
      }
      pollsRun++;

      this.emit(input, 'post-pr-review.poll.completed', 'info', {
        pollNumber,
        outcome: pass.outcome,
        processed: pass.processed,
        blocked: pass.blocked,
      });

      if (pass.allResolved) {
        const hasEverHadComments = d.prReviewRepo.listComments(input.runId).length > 0;
        const pastGraceWindow = d.now() >= firstReviewDeadline;
        if (!hasEverHadComments && !pastGraceWindow) {
          // intentional no-op — the run is still in the initial grace
          // period; we want to keep polling without parking.
        } else {
          if (!allResolvedEmitted) {
            allResolvedEmitted = true;
            this.emit(input, 'post-pr-review.poll.all_resolved', 'info', { pollsRun });
          }
          consecutiveQuietPolls++;
        }
      } else {
        consecutiveQuietPolls = 0;
      }
      if (pass.processed > 0) {
        consecutiveQuietPolls = 0;
      }
      const threshold = Math.max(1, d.quietPollsThreshold ?? 3);
      if (consecutiveQuietPolls >= threshold) {
        this.emit(input, 'post-pr-review.poll.terminal', 'info', {
          terminalState: 'all_resolved',
          pollsRun,
          consecutiveQuietPolls,
        });
        return await this.enterReadyLoop(input, pollsRun, lastAttempt);
      }

      if (!pass.allResolved && pass.blocked > 0 && pass.processed === 0) {
        const hasActiveWork = d.prReviewRepo
          .listComments(input.runId)
          .some((c) => c.state === 'replied' || c.state === 'pending');
        if (!hasActiveWork) {
          this.emit(input, 'post-pr-review.poll.blocked', 'warn', { pollsRun });
          return await this.enterReadyLoop(input, pollsRun, lastAttempt);
        }
      }

      if (pollNumber < effectiveMaxPolls) {
        const cappedMs = Math.max(
          0,
          Math.min(d.pollIntervalMs, deadline.getTime() - d.now().getTime()),
        );
        const nextPollAt = new Date(d.now().getTime() + cappedMs);
        await d.recordTerminalState(lastAttempt, 'running' as PollerTerminalState, nextPollAt);
        await this.cappedSleep(d.pollIntervalMs, deadline);
      }
    }

    if (d.now() >= deadline) {
      this.emit(input, 'post-pr-review.poll.timed_out', 'warn', { pollsRun });
      const result = { terminalState: 'timed_out' as const, pollsRun };
      await d.recordTerminalState(lastAttempt, result.terminalState);
      return result;
    }

    const anyBlocked = d.prReviewRepo.listComments(input.runId).some((c) => c.state === 'blocked');
    if (anyBlocked) {
      this.emit(input, 'post-pr-review.poll.blocked_and_ready', 'warn', { pollsRun });
      return await this.enterReadyLoop(input, pollsRun, lastAttempt);
    }
    const terminal: PollerTerminalState = 'max_polls_reached';
    this.emit(input, 'post-pr-review.poll.max_polls_reached', 'info', { pollsRun });
    await d.recordTerminalState(lastAttempt, terminal);
    return { terminalState: terminal, pollsRun };
  }

  private async enterReadyLoop(
    input: PrReviewPollerInput,
    pollsRun: number,
    lastAttempt: PollAttempt | undefined,
  ): Promise<PrReviewPollerResult> {
    const d = this.deps;
    const check = d.onAllResolved;
    const maxReact = d.maxReactivations ?? 0;
    if (!check || maxReact < 1) {
      await d.recordTerminalState(lastAttempt, 'all_resolved');
      return { terminalState: 'all_resolved', pollsRun };
    }
    let reactivations = 0;
    let wasReactivated = false;
    while (reactivations < maxReact) {
      const action = await check(input);
      this.emit(input, `post-pr-review.ready.${action}`, 'info', { reactivations });
      if (action === 'timeout') {
        // applyReactivation already set run to cancelled — no revert needed
        await d.recordTerminalState(lastAttempt, 'cancelled');
        return { terminalState: 'cancelled', pollsRun };
      }
      if (action === 'stay_ready') {
        // onAllResolved handles running→waiting on the happy path, but on the
        // error path (compose catch returns stay_ready without transitioning)
        // the run is still running — revert unconditionally when reactivated.
        if (wasReactivated) {
          await d.revertRunStatus?.(input.runId);
        }
        await d.recordTerminalState(lastAttempt, 'all_resolved');
        return { terminalState: 'all_resolved', pollsRun };
      }
      wasReactivated = true;
      reactivations++;
      let pass: PollPassResult;
      try {
        const res = await d.processOnePass({
          ...input,
          pollNumber: d.maxPolls + reactivations,
        });
        pass = res.result;
        if (res.attempt) {
          lastAttempt = res.attempt;
        }
      } catch (err) {
        this.emit(input, 'post-pr-review.ready.process_failed', 'warn', {
          reactivations,
          error: String(err),
        });
        if (wasReactivated) {
          await d.revertRunStatus?.(input.runId);
        }
        await d.recordTerminalState(lastAttempt, 'all_resolved');
        return { terminalState: 'all_resolved', pollsRun };
      }
      pollsRun++;
      if (!pass.allResolved) {
        if (wasReactivated) {
          await d.revertRunStatus?.(input.runId);
        }
        await d.recordTerminalState(lastAttempt, 'max_polls_reached');
        return { terminalState: 'max_polls_reached', pollsRun };
      }
      // Still all-resolved after reactivation: the run was successfully handed
      // off to the next executor. Stop looping — calling onAllResolved again
      // would immediately re-reactivate the same run.
      break;
    }
    if (wasReactivated) {
      await d.revertRunStatus?.(input.runId);
    }
    await d.recordTerminalState(lastAttempt, 'all_resolved');
    return { terminalState: 'all_resolved', pollsRun };
  }

  private emit(
    input: PrReviewPollerInput,
    type: string,
    level: 'info' | 'warn' | 'error',
    metadata: Record<string, unknown>,
  ): void {
    this.deps.eventBus.publish(input.runId, {
      runId: input.runId,
      phase: 'post-pr-review',
      level,
      type,
      message: type,
      timestamp: this.deps.now().toISOString(),
      metadata,
    });
  }

  private async cappedSleep(requestedMs: number, deadline: Date): Promise<void> {
    const remaining = deadline.getTime() - this.deps.now().getTime();
    const ms = Math.max(0, Math.min(requestedMs, remaining));
    if (ms > 0) await this.deps.sleep(ms);
  }
}
