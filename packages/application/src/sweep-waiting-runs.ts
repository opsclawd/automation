import { RunStateError } from '@ai-sdlc/domain';
import type { RunRecord, RunRepositoryPort } from './ports.js';
import type { EventBusPort } from './ports/event-bus-port.js';
import type { PrReviewRepositoryPort } from './ports/pr-review-repository-port.js';
import type { GitHubPort } from './ports/github-port.js';
import { decideReactivation } from './pr-review/reactivate-on-review.js';

export interface SweepWaitingRunsDeps {
  runRepository: RunRepositoryPort;
  prReviewRepo: PrReviewRepositoryPort;
  github: GitHubPort;
  eventBus: EventBusPort;
  now: () => Date;
  readyMaxDays: number;
  applyReactivation: (
    run: RunRecord,
    decision: { action: 'reactivate' | 'stay_ready' | 'timeout'; reason: string },
  ) => void;
  resolvePrContext: (
    run: RunRecord,
  ) => Promise<{ repoFullName: string; prNumber: number } | undefined>;
}

export interface SweepWaitingRunsResult {
  scanned: number;
  reactivated: number;
  reactivatedRuns: Array<{ run: RunRecord; reason: string }>;
  timedOut: number;
  passedOnMergedPr: number;
  cancelledOnClosedPr: number;
  stayedReady: number;
  skipped: number;
  errors: Array<{ runId: string; error: string }>;
}

export class SweepWaitingRuns {
  constructor(private readonly deps: SweepWaitingRunsDeps) {}

  async execute(): Promise<SweepWaitingRunsResult> {
    const now = this.deps.now;
    const result: SweepWaitingRunsResult = {
      scanned: 0,
      reactivated: 0,
      reactivatedRuns: [],
      timedOut: 0,
      passedOnMergedPr: 0,
      cancelledOnClosedPr: 0,
      stayedReady: 0,
      skipped: 0,
      errors: [],
    };

    const active = this.deps.runRepository.findActiveRuns();
    const waiting = active.filter((r) => r.status === 'waiting');

    for (const run of waiting) {
      result.scanned++;
      try {
        const ctx = await this.deps.resolvePrContext(run);
        if (!ctx) {
          result.skipped++;
          this.deps.eventBus.publish(run.uuid, {
            runId: run.uuid,
            phase: 'post-pr-review',
            level: 'warn',
            type: 'post-pr-review.sweep.skipped',
            message: 'sweep skipped: PR context unresolved',
            timestamp: now().toISOString(),
            metadata: { reason: 'pr_context_unresolved' },
          });
          continue;
        }

        let prDetail: Awaited<ReturnType<GitHubPort['getPr']>>;
        try {
          prDetail = await this.deps.github.getPr(ctx.repoFullName, ctx.prNumber);
        } catch (err) {
          result.errors.push({
            runId: run.uuid,
            error: `github.getPr failed: ${err instanceof Error ? err.message : String(err)}`,
          });
          this.deps.eventBus.publish(run.uuid, {
            runId: run.uuid,
            phase: 'post-pr-review',
            level: 'error',
            type: 'post-pr-review.sweep.error',
            message: 'sweep error: github.getPr failed',
            timestamp: now().toISOString(),
            metadata: { error: String(err) },
          });
          continue;
        }

        if (prDetail.state === 'merged') {
          try {
            this.deps.applyReactivation(run, {
              action: 'reactivate',
              reason: 'PR merged — finalizing run',
            });
            const mergedAt = now();
            const updated = this.deps.runRepository.atomicUpdateByUuid(
              run.uuid,
              {
                status: 'passed',
                completedAt: mergedAt,
              },
              'waiting',
            );
            if (updated) {
              this.deps.eventBus.publish(run.uuid, {
                runId: run.uuid,
                phase: 'post-pr-review',
                level: 'info',
                type: 'post-pr-review.run.passed',
                message: 'PR merged — run passed',
                timestamp: mergedAt.toISOString(),
                metadata: { reason: 'pr_merged' },
              });
              result.passedOnMergedPr++;
            }
          } catch (err) {
            result.errors.push({
              runId: run.uuid,
              error: `merge handling failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
          continue;
        }

        if (prDetail.state === 'closed') {
          try {
            this.deps.applyReactivation(run, {
              action: 'reactivate',
              reason: 'PR closed — finalizing run',
            });
            const closedAt = now();
            const updated = this.deps.runRepository.atomicUpdateByUuid(
              run.uuid,
              {
                status: 'cancelled',
                completedAt: closedAt,
                failureReason: 'PR closed',
              },
              'waiting',
            );
            if (updated) {
              this.deps.eventBus.publish(run.uuid, {
                runId: run.uuid,
                phase: 'post-pr-review',
                level: 'warn',
                type: 'post-pr-review.run.cancelled',
                message: 'PR closed — run cancelled',
                timestamp: closedAt.toISOString(),
                metadata: { reason: 'pr_closed' },
              });
              result.cancelledOnClosedPr++;
            }
          } catch (err) {
            result.errors.push({
              runId: run.uuid,
              error: `close handling failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
          continue;
        }

        let comments: Awaited<ReturnType<GitHubPort['listReviewComments']>>;
        try {
          comments = await this.deps.github.listReviewComments(ctx.repoFullName, ctx.prNumber);
        } catch (err) {
          result.errors.push({
            runId: run.uuid,
            error: `listReviewComments failed: ${err instanceof Error ? err.message : String(err)}`,
          });
          this.deps.eventBus.publish(run.uuid, {
            runId: run.uuid,
            phase: 'post-pr-review',
            level: 'error',
            type: 'post-pr-review.sweep.error',
            message: 'sweep error: listReviewComments failed',
            timestamp: now().toISOString(),
            metadata: { error: String(err) },
          });
          continue;
        }

        const readyAt = run.completedAt ?? run.startedAt;
        const newestCommentAt = comments.reduce(
          (max, c) => (c.createdAt.getTime() > max.getTime() ? c.createdAt : max),
          readyAt,
        );
        const lastAttempt = this.deps.prReviewRepo.latestPollAttempt(run.uuid as never);
        const lastSeenActivityAt = lastAttempt?.startedAt ?? run.startedAt;
        const decision = decideReactivation({
          readyAt,
          now: now(),
          readyMaxDays: this.deps.readyMaxDays,
          lastSeenActivityAt,
          newestCommentAt,
        });

        try {
          this.deps.applyReactivation(run, decision);
          if (decision.action === 'reactivate') {
            result.reactivated++;
            result.reactivatedRuns.push({ run, reason: decision.reason });
          } else if (decision.action === 'timeout') result.timedOut++;
          else result.stayedReady++;
        } catch (err) {
          if (err instanceof RunStateError) {
            result.errors.push({
              runId: run.uuid,
              error: `concurrent_status_change: ${err.message}`,
            });
            this.deps.eventBus.publish(run.uuid, {
              runId: run.uuid,
              phase: 'post-pr-review',
              level: 'warn',
              type: 'post-pr-review.sweep.skipped',
              message: 'sweep skipped: concurrent status change',
              timestamp: now().toISOString(),
              metadata: { reason: 'concurrent_status_change' },
            });
          } else {
            result.errors.push({
              runId: run.uuid,
              error: `applyReactivation failed: ${err instanceof Error ? err.message : String(err)}`,
            });
            this.deps.eventBus.publish(run.uuid, {
              runId: run.uuid,
              phase: 'post-pr-review',
              level: 'error',
              type: 'post-pr-review.sweep.error',
              message: 'sweep error: applyReactivation failed',
              timestamp: now().toISOString(),
              metadata: { error: String(err) },
            });
          }
        }
      } catch (err) {
        result.errors.push({
          runId: run.uuid,
          error: err instanceof Error ? err.message : String(err),
        });
        this.deps.eventBus.publish(run.uuid, {
          runId: run.uuid,
          phase: 'post-pr-review',
          level: 'error',
          type: 'post-pr-review.sweep.error',
          message: 'sweep error: unexpected',
          timestamp: now().toISOString(),
          metadata: { error: String(err) },
        });
      }
    }

    return result;
  }
}
