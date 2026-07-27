import {
  RunId,
  RepositoryId,
  PhaseName,
  createPrReviewComment,
  markProcessed,
  blockComment,
  isUnresolved,
  resetForRetry,
  type PrReviewComment,
  type PollAttempt,
} from '@ai-sdlc/domain';
import type { PostPrReviewAttemptMode } from './poll-task-runner.js';
import { verifyComment } from './verify-comment.js';
import type { VerifyCodeChangeFn } from './verify-code-change.js';
import type { FixDiffInspectorPort } from '../ports/fix-diff-inspector-port.js';
import type { GitHubPort } from '../ports/github-port.js';
import type { GitPort } from '../ports/git-port.js';
import type { AgentPort } from '../ports/agent-port.js';
import type { AgentProfileName } from '../ports/agent-invocation-types.js';
import type { PrReviewRepositoryPort } from '../ports/pr-review-repository-port.js';
import type {
  PollTaskResult,
  PollTaskBatchResultEntry,
} from '../results/schemas/poll-task-result.js';
import {
  isPollTaskManifestV2,
  selectCommentsFromManifest,
} from '../results/schemas/poll-task-manifest.js';
import { PollTaskRunner } from './poll-task-runner.js';
import type { PollTaskOutput } from './poll-task-runner.js';
import type { ArtifactStore } from '../ports/artifact-store.js';
import type { PrReviewContextSourcePort } from '../ports/pr-review-context-source-port.js';
import { selectPrReviewContext, type SelectedPrReviewContext } from './context-selector.js';
import { groupCommentsIntoBatches } from './comment-batcher.js';

export interface ContextSelectedEvent {
  level: number;
  commentIds: readonly number[];
  includedFiles: readonly string[];
  includedHunks: readonly string[];
  includedSymbols: readonly string[];
  fullDiffIncluded: boolean;
  fallbackReason?: string;
}

export interface ProcessPrReviewDeps {
  github: GitHubPort;
  git: GitPort;
  agent: AgentPort;
  prReviewRepo: PrReviewRepositoryPort;
  renderTaskPrompt: (input: {
    cwd: string;
    comment: PrReviewComment;
    diff: string;
    branch: string;
    mode: PostPrReviewAttemptMode;
    previousBuildError?: string;
    previousCodeVerifyReason?: string;
    dispositions?: Array<{
      fingerprint: string;
      disposition: string;
      reason?: string;
    }>;
  }) => Promise<string>;
  extractTaskResult: (input: {
    resultJsonPath?: string;
    cwd: string;
  }) => Promise<
    { ok: true; result: PollTaskResult } | { ok: false; reason: string; detail: string }
  >;
  renderBatchTaskPrompt?: (input: {
    cwd: string;
    comments: PrReviewComment[];
    diff: string;
    branch: string;
    mode: PostPrReviewAttemptMode;
    context: SelectedPrReviewContext;
    attempt: number;
    previousBuildError?: string;
    previousCodeVerifyReason?: string;
    dispositions?: Array<{
      commentId: number;
      fingerprint: string;
      disposition: string;
      reason?: string;
    }>;
  }) => Promise<string>;
  extractBatchTaskResult?: (input: {
    resultJsonPath?: string;
    cwd: string;
  }) => Promise<
    { ok: true; result: PollTaskBatchResultEntry[] } | { ok: false; reason: string; detail: string }
  >;
  verifyCommitPushed: (input: {
    cwd: string;
    branch: string;
    startCommitSha: string;
    commitSha?: string;
  }) => Promise<boolean>;
  verifyBuildPasses: (input: {
    cwd: string;
    runId: string;
  }) => Promise<{ passed: boolean; error?: string }>;
  verifyCodeChange?: VerifyCodeChangeFn;
  fixDiffInspector?: FixDiffInspectorPort;
  resolveProfileForPhase: (phaseName: string) => AgentProfileName;
  idFactory: () => string;
  now: () => Date;
  artifactStore: ArtifactStore;
  baseBranch?: string;
  repoRoot?: string | undefined;
  onWarning?: (message: string, metadata: Record<string, unknown>, runId: string) => void;
  rollbackFix?: (ctx: { cwd: string; branch: string }, targetSha: string) => Promise<boolean>;
  contextSource?: PrReviewContextSourcePort;
  onContextSelected?: (event: ContextSelectedEvent) => void;
}

export interface ProcessPrReviewInput {
  runId: RunId;
  repoId: RepositoryId;
  repoFullName: string;
  prNumber: number;
  cwd: string;
  phaseId: PhaseName;
  pollNumber: number;
}

export interface ProcessPrReviewOutput {
  outcome: 'ALL_RESOLVED' | 'PARTIAL_PROGRESS' | 'BLOCKED' | 'NO_UNRESOLVED';
  processed: number;
  blocked: number;
  allResolved: boolean;
}

const ESCALATION_BUDGET = 3;

export class ProcessPrReviewComments {
  constructor(private readonly deps: ProcessPrReviewDeps) {}

  async execute(input: ProcessPrReviewInput): Promise<ProcessPrReviewOutput> {
    const d = this.deps;
    const startedAt = d.now();

    const raw = await d.github.listReviewComments(input.repoFullName, input.prNumber);
    const reviews = await d.github.listReviews(input.repoFullName, input.prNumber);
    const approvedReviewIds = new Set(
      reviews.filter((r) => r.state === 'APPROVED').map((r) => r.id),
    );
    const reviewerComments = raw.filter(
      (c) => c.inReplyToId === undefined && !approvedReviewIds.has(c.reviewId ?? 0),
    );

    for (const rc of reviewerComments) {
      if (!d.prReviewRepo.getComment(input.runId, rc.id)) {
        d.prReviewRepo.upsertComment(
          createPrReviewComment({
            runId: input.runId,
            prNumber: input.prNumber,
            commentId: rc.id,
            path: rc.path,
            line: rc.line ?? 0,
            reviewer: rc.reviewer,
            body: rc.body,
            now: d.now(),
          }),
        );
      }
    }

    const unresolved = d.prReviewRepo.listComments(input.runId).filter((c) => isUnresolved(c));

    if (unresolved.length === 0) {
      await this.verifyOrphaned(input, undefined);

      const allComments = d.prReviewRepo.listComments(input.runId);
      const stillUnresolved = allComments.filter(isUnresolved);
      const hasRepliedUnverified = allComments.some(
        (c) => c.state === 'replied' && !c.replyVerified,
      );
      const hasBlocked = allComments.some((c) => c.state === 'blocked');
      const blockedCount = allComments.filter((c) => c.state === 'blocked').length;

      let terminal: PollAttempt['terminalState'];
      if (stillUnresolved.length > 0 || hasRepliedUnverified) {
        terminal = undefined;
      } else if (hasBlocked) {
        terminal = 'blocked';
      } else {
        terminal = 'all_resolved';
      }

      this.recordPoll(input, startedAt, reviewerComments.length, 0, terminal);
      return {
        outcome: 'NO_UNRESOLVED',
        processed: 0,
        blocked: blockedCount,
        allResolved: stillUnresolved.length === 0 && !hasRepliedUnverified && !hasBlocked,
      };
    }

    const pr = await d.github.getPr(input.repoFullName, input.prNumber);
    if (pr.state !== 'open') {
      this.recordPoll(input, startedAt, unresolved.length, 0, undefined, 'failed');
      return {
        outcome: 'BLOCKED',
        processed: 0,
        blocked: 0,
        allResolved: false,
      };
    }

    const startCommitSha = await d.git.headCommitSha(input.cwd);
    const originalStartCommitSha = startCommitSha;
    const originalStart = originalStartCommitSha;

    const mainShaBefore = d.baseBranch
      ? await d.git.remoteRef({ cwd: input.cwd, remote: 'origin', ref: d.baseBranch })
      : undefined;
    const localMainShaBefore =
      d.repoRoot && d.baseBranch ? await d.git.headCommitShaOf(d.repoRoot) : undefined;

    const manifest = this.generateManifest(unresolved);
    const taskRunner = new PollTaskRunner(d);
    const taskResults: PollTaskOutput[] = [];
    // Each batch's agent may commit, advancing HEAD. Later batches must verify
    // against the HEAD as of when they start, not the stale poll-start SHA. (M1)
    let runningStartSha = startCommitSha;

    const useBatching = d.renderBatchTaskPrompt && d.extractBatchTaskResult && d.contextSource;

    for (const batch of manifest.tasks) {
      // Re-read live state: a comment may have been resolved or blocked since the
      // manifest was built (e.g. by a prior poll's orphan verification). Only
      // process comments that are still pending. (M2)
      const batchComments = batch.comments
        .map((c) => d.prReviewRepo.getComment(input.runId, c.commentId))
        .filter((c): c is PrReviewComment => c !== undefined && c.state === 'pending');
      if (batchComments.length === 0) continue;

      runningStartSha = await d.git.headCommitSha(input.cwd);

      let previousBuildError: string | undefined;
      let previousCodeVerifyReason: string | undefined;

      for (let attempt = 1; attempt <= ESCALATION_BUDGET; attempt++) {
        // Re-check live state at each attempt
        const currentBatchComments = batchComments
          .map((c) => d.prReviewRepo.getComment(input.runId, c.commentId))
          .filter((c): c is PrReviewComment => c !== undefined && c.state === 'pending');
        if (currentBatchComments.length === 0) break;

        const previousAttempts = currentBatchComments.flatMap((c) =>
          d.prReviewRepo.listCommentAttempts(input.runId, c.commentId),
        );

        let currentDiff: string;
        try {
          if (attempt === 1) {
            currentDiff = await d.git.diff(input.cwd, 'origin/HEAD', runningStartSha);
          } else {
            const lastCompletedAttempt = previousAttempts
              .filter((a) => a.completedHead)
              .sort((a, b) => b.retryNumber - a.retryNumber)[0];
            if (!lastCompletedAttempt || !lastCompletedAttempt.completedHead) {
              throw new Error(`Missing completedHead snapshot for retry attempt ${attempt}`);
            }
            currentDiff = await d.git.diff(
              input.cwd,
              lastCompletedAttempt.completedHead,
              runningStartSha,
            );
          }
        } catch (error: unknown) {
          const reason = `Diff generation failed: ${error instanceof Error ? error.message : String(error)}`;
          for (const c of currentBatchComments) {
            d.prReviewRepo.upsertComment(blockComment(c, reason));
          }
          taskResults.push(
            ...currentBatchComments.map((c) => ({
              commentId: c.commentId,
              action: 'failed' as const,
              processed: false,
              blocked: true,
            })),
          );
          break;
        }

        const dispositions = previousAttempts.map((a) => {
          const item: {
            commentId: number;
            fingerprint: string;
            disposition: string;
            reason?: string;
          } = {
            commentId: a.commentId,
            fingerprint: a.attemptId,
            disposition: String(a.disposition ?? 'failure'),
          };
          const r = a.verifierFeedback ?? a.buildFeedback;
          if (r !== undefined) {
            item.reason = r;
          }
          return item;
        });

        const reviewMode: PostPrReviewAttemptMode =
          attempt === 1 ? 'initial_full' : 'intermediate_delta';

        if (useBatching) {
          const snapshot = await d.contextSource!({
            cwd: input.cwd,
            base: 'origin/HEAD',
            head: runningStartSha,
            seedPaths: batch.comments.map((c) => c.path),
          });

          const context = selectPrReviewContext({
            comments: currentBatchComments,
            attempt: Math.min(attempt, 3) as import('./context-selector.js').PrReviewContextLevel,
            snapshot,
            previousBuildErrors: previousBuildError !== undefined ? [previousBuildError] : [],
            previousVerifierReasons:
              previousCodeVerifyReason !== undefined ? [previousCodeVerifyReason] : [],
          });

          d.onContextSelected?.({
            level: context.level,
            commentIds: currentBatchComments.map((c) => c.commentId),
            includedFiles: context.includedFiles,
            includedHunks: context.includedHunks,
            includedSymbols: context.includedSymbols,
            fullDiffIncluded: context.fullDiffIncluded,
            ...(context.fallbackReason !== undefined
              ? { fallbackReason: context.fallbackReason }
              : {}),
          });

          const batchResult = await taskRunner.executeBatch({
            ...input,
            comments: currentBatchComments,
            diff: currentDiff,
            branch: pr.headRefName,
            startCommitSha: runningStartSha,
            originalStartCommitSha: originalStartCommitSha,
            unresolvedCommentCount: unresolved.length,
            ...(previousBuildError !== undefined ? { previousBuildError } : {}),
            ...(previousCodeVerifyReason !== undefined ? { previousCodeVerifyReason } : {}),
            reviewMode,
            retryNumber: attempt,
            dispositions,
            contextLevel: context.level,
            contextFiles: [...context.includedFiles],
            fullDiffIncluded: context.fullDiffIncluded,
            selectedContext: context,
          });

          taskResults.push(...batchResult.outputs);

          const allDone = batchResult.outputs.every(
            (o) => o.processed || o.blocked || o.action === 'no_fix',
          );
          if (allDone) break;

          const firstFailed = batchResult.outputs.find((o) => o.buildError);
          if (firstFailed?.buildError) {
            previousBuildError = firstFailed.buildError;
          }
          const firstFailedCode = batchResult.outputs.find((o) => o.codeVerifyReason);
          if (firstFailedCode?.codeVerifyReason) {
            previousCodeVerifyReason = firstFailedCode.codeVerifyReason;
          }

          if (attempt === ESCALATION_BUDGET) {
            const unresolvedOutputs = batchResult.outputs.filter(
              (o) => !o.processed && !o.blocked && o.action !== 'no_fix',
            );
            for (const output of unresolvedOutputs) {
              const comment = currentBatchComments.find((c) => c.commentId === output.commentId);
              if (!comment) continue;
              let fallbackReason = `batch task failed after ${ESCALATION_BUDGET} attempts`;
              if (output.codeVerifyReason !== undefined) {
                fallbackReason = `verified incorrect: ${output.codeVerifyReason}`;
              } else if (output.buildError !== undefined) {
                fallbackReason = `code verified correct but build failing: ${output.buildError}`;
              }
              d.prReviewRepo.upsertComment(blockComment(comment, fallbackReason));
              const rollbackOk = await d.rollbackFix?.(
                { cwd: input.cwd, branch: pr.headRefName },
                runningStartSha,
              );
              if (rollbackOk === false) {
                d.onWarning?.(
                  'rollbackFix failed: broken commits may remain on remote branch',
                  { branch: pr.headRefName, cwd: input.cwd, targetSha: runningStartSha },
                  String(input.runId),
                );
              }
            }
          }
        } else {
          for (const currentComment of currentBatchComments) {
            let lastOutput: PollTaskOutput | undefined;
            const commentPreviousAttempts = d.prReviewRepo.listCommentAttempts(
              input.runId,
              currentComment.commentId,
            );
            try {
              lastOutput = await taskRunner.execute({
                ...input,
                comment: currentComment,
                diff: currentDiff,
                branch: pr.headRefName,
                startCommitSha: runningStartSha,
                originalStartCommitSha: originalStartCommitSha,
                unresolvedCommentCount: unresolved.length,
                reviewMode,
                retryNumber: attempt,
                dispositions: commentPreviousAttempts.map((a) => {
                  const disposition = String(a.disposition ?? 'failure');
                  const reason = a.verifierFeedback ?? a.buildFeedback;
                  return {
                    commentId: a.commentId,
                    fingerprint: a.attemptId,
                    disposition,
                    ...(reason !== undefined ? { reason } : {}),
                  };
                }),
                ...(previousBuildError !== undefined ? { previousBuildError } : {}),
                ...(previousCodeVerifyReason !== undefined ? { previousCodeVerifyReason } : {}),
              });
              if (lastOutput.processed || lastOutput.blocked || lastOutput.action === 'no_fix') {
                taskResults.push(lastOutput);
                continue;
              }
            } catch {
              lastOutput = {
                commentId: currentComment.commentId,
                action: 'failed',
                processed: false,
                blocked: false,
              };
            }
            if (lastOutput.buildError !== undefined) {
              previousBuildError = lastOutput.buildError;
            }
            if (lastOutput.codeVerifyReason !== undefined) {
              previousCodeVerifyReason = lastOutput.codeVerifyReason;
            }
            if (
              attempt === ESCALATION_BUDGET &&
              lastOutput &&
              !lastOutput.processed &&
              !lastOutput.blocked
            ) {
              let fallbackReason = `task failed after ${ESCALATION_BUDGET} attempts`;
              if (lastOutput.codeVerifyReason !== undefined) {
                fallbackReason = `verified incorrect: ${lastOutput.codeVerifyReason}`;
              } else if (lastOutput.buildError !== undefined) {
                fallbackReason = `code verified correct but build failing: ${lastOutput.buildError}`;
              }
              d.prReviewRepo.upsertComment(blockComment(currentComment, fallbackReason));
              const rollbackOk = await d.rollbackFix?.(
                { cwd: input.cwd, branch: pr.headRefName },
                runningStartSha,
              );
              if (rollbackOk === false) {
                d.onWarning?.(
                  'rollbackFix failed: broken commits may remain on remote branch',
                  { branch: pr.headRefName, cwd: input.cwd, targetSha: runningStartSha },
                  String(input.runId),
                );
              }
              lastOutput = {
                commentId: currentComment.commentId,
                action: 'failed',
                processed: false,
                blocked: true,
              };
            }
            if (lastOutput) {
              taskResults.push(lastOutput);
            }
          }
          const allDone = taskResults
            .filter((tr) => currentBatchComments.some((c) => c.commentId === tr.commentId))
            .every((o) => o.processed || o.blocked || o.action === 'no_fix');
          if (allDone) break;
        }
      }
    }

    if (d.baseBranch && mainShaBefore) {
      const mainShaAfter = await d.git.remoteRef({
        cwd: input.cwd,
        remote: 'origin',
        ref: d.baseBranch,
      });
      if (mainShaAfter && mainShaAfter !== mainShaBefore) {
        d.onWarning?.(
          'main branch changed during agent run',
          {
            baseBranch: d.baseBranch,
            shaBefore: mainShaBefore,
            shaAfter: mainShaAfter,
            prNumber: input.prNumber,
          },
          String(input.runId),
        );
      }
    }
    if (d.repoRoot && d.baseBranch && localMainShaBefore) {
      const localMainShaAfter = await d.git.headCommitShaOf(d.repoRoot);
      if (localMainShaAfter && localMainShaAfter !== localMainShaBefore) {
        d.onWarning?.(
          'local main checkout changed during agent run',
          {
            baseBranch: d.baseBranch,
            shaBefore: localMainShaBefore,
            shaAfter: localMainShaAfter,
            prNumber: input.prNumber,
          },
          String(input.runId),
        );
      }
    }

    let processed = 0;
    let blocked = 0;
    for (const tr of taskResults) {
      if (tr.processed) processed++;
      if (tr.blocked) blocked++;
    }

    const orphanResult = await this.verifyOrphaned(input, originalStart);
    blocked += orphanResult.blocked;
    processed += orphanResult.newlyProcessed;

    const allComments = d.prReviewRepo.listComments(input.runId);
    const stillUnresolved = allComments.filter(isUnresolved);
    const hasRepliedUnverified = allComments.some((c) => c.state === 'replied' && !c.replyVerified);
    const hasBlocked = allComments.some((c) => c.state === 'blocked');

    let terminal: PollAttempt['terminalState'];
    if (stillUnresolved.length > 0 || hasRepliedUnverified) {
      terminal = undefined;
    } else if (hasBlocked) {
      terminal = 'blocked';
    } else {
      terminal = 'all_resolved';
    }

    let outcome: 'ALL_RESOLVED' | 'PARTIAL_PROGRESS' | 'BLOCKED';
    if (processed > 0 && stillUnresolved.length === 0 && !hasRepliedUnverified && !hasBlocked) {
      outcome = 'ALL_RESOLVED';
    } else if (processed > 0 || blocked > 0) {
      outcome = 'PARTIAL_PROGRESS';
    } else {
      outcome = 'BLOCKED';
    }

    this.recordPoll(input, startedAt, unresolved.length, processed, terminal);

    return {
      outcome,
      processed,
      blocked,
      allResolved: stillUnresolved.length === 0 && !hasRepliedUnverified && !hasBlocked,
    };
  }

  private async verifyOrphaned(
    input: ProcessPrReviewInput,
    startCommitSha: string | undefined,
    skipCommentIds: Set<number> = new Set(),
  ): Promise<{ blocked: number; newlyProcessed: number }> {
    const d = this.deps;
    const allComments = d.prReviewRepo.listComments(input.runId);
    const orphaned = allComments.filter(
      (c) => c.state === 'replied' && !c.replyVerified && !skipCommentIds.has(c.commentId),
    );

    if (orphaned.length === 0) return { blocked: 0, newlyProcessed: 0 };

    const pr = await d.github.getPr(input.repoFullName, input.prNumber);

    let blocked = 0;
    let newlyProcessed = 0;
    for (const c of orphaned) {
      const verification = await verifyComment(c, d, {
        cwd: input.cwd,
        branch: pr.headRefName,
        prNumber: input.prNumber,
        repoFullName: input.repoFullName,
        originalStartCommitSha: startCommitSha,
        runningStartSha: startCommitSha,
        commentId: c.commentId,
      });

      if (verification.ok) {
        d.prReviewRepo.upsertComment(
          markProcessed(c, {
            commitVerified: verification.commitVerified,
            replyVerified: verification.replyVerified,
            buildVerified: verification.buildVerified,
          }),
        );
        await d.github.resolveReviewThread(input.repoFullName, input.prNumber, c.commentId);
        newlyProcessed++;
      } else if (c.attempts >= ESCALATION_BUDGET) {
        d.prReviewRepo.upsertComment(blockComment(c, 'verification failed'));
        blocked++;
      } else {
        d.prReviewRepo.upsertComment(resetForRetry(c, { poll: input.pollNumber }));
      }
    }
    return { blocked, newlyProcessed };
  }

  private translateBlockReason(
    v: {
      ok: boolean;
      codeVerified: boolean;
      buildVerified: boolean;
      codeVerifyReason?: string;
      buildError?: string;
      reason: string;
    },
    _comment: PrReviewComment,
    budget: number,
  ): string {
    if (v.codeVerified && !v.buildVerified) {
      return `code verified correct but build failing: ${v.buildError ?? 'unknown build error'}`;
    }
    if (!v.codeVerified && v.codeVerifyReason) {
      return `verified incorrect: ${v.codeVerifyReason}`;
    }
    return `verification failed: ${v.reason ?? `task failed after ${budget} attempts`}`;
  }

  private generateManifest(
    comments: PrReviewComment[],
    diff?: string,
  ): import('../results/schemas/poll-task-manifest.js').PollTaskManifestV2 {
    const batches = groupCommentsIntoBatches(comments, { ...(diff !== undefined ? { diff } : {}) });
    const commentMap = new Map(comments.map((c) => [c.commentId, c]));

    const tasks = batches.map((batch) => {
      const batchComments: Array<{
        commentId: number;
        path: string;
        line: number;
        body: string;
        reviewer: string;
      }> = [];

      for (const id of batch.commentIds) {
        const c = commentMap.get(id);
        if (c) {
          batchComments.push({
            commentId: c.commentId,
            path: c.path,
            line: c.line,
            body: c.body,
            reviewer: c.reviewer,
          });
        }
      }

      return {
        id: `batch-${batch.groupKey}`,
        groupKey: batch.groupKey,
        priority: batch.priority,
        comments: batchComments,
      };
    });

    return {
      version: 2 as const,
      taskCount: comments.length,
      tasks,
    };
  }

  private recordPoll(
    input: ProcessPrReviewInput,
    startedAt: Date,
    fetched: number,
    processed: number,
    terminalState?: PollAttempt['terminalState'],
    status: PollAttempt['status'] = 'completed',
  ): void {
    this.deps.prReviewRepo.insertPollAttempt({
      id: this.deps.idFactory(),
      runId: input.runId,
      prNumber: input.prNumber,
      pollNumber: input.pollNumber,
      status,
      commentsFetched: fetched,
      commentsProcessed: processed,
      startedAt,
      completedAt: this.deps.now(),
      ...(terminalState ? { terminalState } : {}),
    });
  }
}

export function isBatchManifest(
  manifest: unknown,
): manifest is import('../results/schemas/poll-task-manifest.js').PollTaskManifestV2 {
  return isPollTaskManifestV2(manifest);
}

export { selectCommentsFromManifest };
