import type { RunId, RepositoryId, PhaseName, PollAttempt } from '@ai-sdlc/domain';
import type { EventBusPort } from '../ports/event-bus-port.js';
import type { PrReviewRepositoryPort } from '../ports/pr-review-repository-port.js';

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
}

export interface PrReviewPollerInput {
  runId: RunId;
  repoId: RepositoryId;
  repoFullName: string;
  prNumber: number;
  cwd: string;
  phaseId: PhaseName;
}

export type PollerTerminalState = 'all_resolved' | 'max_polls_reached' | 'blocked' | 'timed_out';

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
    const meaningfulAttempts = existingAttempts.filter((a) => a.status !== 'rate_limited');
    let pollsRun = meaningfulAttempts.length;
    let lastAttempt: PollAttempt | undefined =
      existingAttempts.length > 0 ? existingAttempts[existingAttempts.length - 1] : undefined;
    let consecutiveFailures = 0;

    for (let pollNumber = meaningfulAttempts.length + 1; pollNumber <= d.maxPolls; pollNumber++) {
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
        this.emit(input, 'post-pr-review.poll.all_resolved', 'info', { pollsRun });
        const result = { terminalState: 'all_resolved' as const, pollsRun };
        await d.recordTerminalState(lastAttempt, result.terminalState);
        return result;
      }

      if (!pass.allResolved && pass.blocked > 0 && pass.processed === 0) {
        const hasActiveWork = d.prReviewRepo
          .listComments(input.runId)
          .some((c) => c.state === 'replied' || c.state === 'pending');
        if (!hasActiveWork) {
          this.emit(input, 'post-pr-review.poll.blocked', 'warn', { pollsRun });
          const result = { terminalState: 'blocked' as const, pollsRun };
          await d.recordTerminalState(lastAttempt, result.terminalState);
          return result;
        }
      }

      if (pollNumber < d.maxPolls) {
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
    const terminal: PollerTerminalState = anyBlocked ? 'blocked' : 'max_polls_reached';
    this.emit(input, `post-pr-review.poll.${terminal}`, terminal === 'blocked' ? 'warn' : 'info', {
      pollsRun,
    });
    await d.recordTerminalState(lastAttempt, terminal);
    return { terminalState: terminal, pollsRun };
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
