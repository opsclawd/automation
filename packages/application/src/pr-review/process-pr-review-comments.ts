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
import type { PollTaskOutput, PollBatchTaskOutput } from './poll-task-runner.js';
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

export interface ReviewBatchWorkItem {
  readonly commentIds: readonly number[];
  readonly attempt: 1 | 2 | 3;
  readonly batchStartSha: string;
  readonly previousBuildErrors: Readonly<Record<number, string>>;
  readonly previousVerifierReasons: Readonly<Record<number, string>>;
}

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

    // Each batch's agent may commit, advancing HEAD. Later batches must verify
    // against the HEAD as of when they start, not the stale poll-start SHA. (M1)
    let runningStartSha = await d.git.headCommitSha(input.cwd);
    const initialDiff = await d.git.diff(input.cwd, 'origin/HEAD', runningStartSha);
    const manifest = this.generateManifest(unresolved, initialDiff);
    const taskRunner = new PollTaskRunner(d);
    const taskResults: PollTaskOutput[] = [];

    // Reused as the first batch's first-attempt diff so the manifest-generation
    // diff fetch and the attempt-1 diff fetch are not duplicated when HEAD has
    // not moved between the two.
    let cachedFirstDiff: string | undefined = initialDiff;

    const useBatching = Boolean(d.renderBatchTaskPrompt && d.extractBatchTaskResult);

    // Build initial FIFO work queue from manifest batches
    const workQueue: ReviewBatchWorkItem[] = [];
    for (const batch of manifest.tasks) {
      const batchComments = batch.comments
        .map((c) => d.prReviewRepo.getComment(input.runId, c.commentId))
        .filter((c): c is PrReviewComment => c !== undefined && c.state === 'pending');
      if (batchComments.length === 0) continue;

      workQueue.push({
        commentIds: batchComments.map((c) => c.commentId),
        attempt: 1,
        batchStartSha: runningStartSha,
        previousBuildErrors: {},
        previousVerifierReasons: {},
      });
    }

    // Process FIFO work queue
    while (workQueue.length > 0) {
      const workItem = workQueue.shift()!;
      const {
        commentIds,
        attempt,
        batchStartSha: itemBatchStartSha,
        previousBuildErrors,
        previousVerifierReasons,
      } = workItem;

      // Re-read live HEAD at start of work item
      const itemLiveStartSha =
        attempt === 1 && cachedFirstDiff !== undefined
          ? runningStartSha
          : await d.git.headCommitSha(input.cwd);
      runningStartSha = itemLiveStartSha;

      const activeBatchStartSha = attempt === 1 ? itemLiveStartSha : itemBatchStartSha;

      // Re-read live state for these comment IDs
      const currentComments = commentIds
        .map((id) => d.prReviewRepo.getComment(input.runId, id))
        .filter((c): c is PrReviewComment => c !== undefined && c.state === 'pending');
      if (currentComments.length === 0) continue;

      // Gather previous attempts for all comments in this work item
      const previousAttempts = currentComments.flatMap((c) =>
        d.prReviewRepo.listCommentAttempts(input.runId, c.commentId),
      );

      // Generate diff
      let currentDiff: string;
      try {
        if (attempt === 1) {
          if (cachedFirstDiff !== undefined) {
            currentDiff = cachedFirstDiff;
            cachedFirstDiff = undefined;
          } else {
            currentDiff = await d.git.diff(input.cwd, 'origin/HEAD', itemLiveStartSha);
          }
        } else {
          currentDiff = await d.git.diff(input.cwd, 'origin/HEAD', itemLiveStartSha);
        }
      } catch (error: unknown) {
        const reason = `Diff generation failed: ${error instanceof Error ? error.message : String(error)}`;
        for (const c of currentComments) {
          d.prReviewRepo.upsertComment(blockComment(c, reason));
        }
        taskResults.push(
          ...currentComments.map((c) => ({
            commentId: c.commentId,
            action: 'failed' as const,
            processed: false,
            blocked: true,
          })),
        );
        continue;
      }

      // Build per-comment dispositions map
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

      const perCommentBuildErrors: Record<number, string> = { ...previousBuildErrors };
      const perCommentVerifierReasons: Record<number, string> = { ...previousVerifierReasons };

      for (const output of taskResults) {
        if (output.buildError !== undefined) {
          perCommentBuildErrors[output.commentId] = output.buildError;
        }
        if (output.codeVerifyReason !== undefined) {
          perCommentVerifierReasons[output.commentId] = output.codeVerifyReason;
        }
      }

      if (useBatching) {
        let context: SelectedPrReviewContext;
        const contextLevel = Math.min(
          attempt,
          3,
        ) as import('./context-selector.js').PrReviewContextLevel;

        if (d.contextSource) {
          try {
            const snapshot = await d.contextSource({
              cwd: input.cwd,
              base: 'origin/HEAD',
              head: itemLiveStartSha,
              seedPaths: Array.from(new Set(currentComments.map((c) => c.path))),
            });

            const buildErrorsArray = currentComments
              .map((c) => perCommentBuildErrors[c.commentId])
              .filter((e): e is string => Boolean(e));
            const verifierReasonsArray = currentComments
              .map((c) => perCommentVerifierReasons[c.commentId])
              .filter((r): r is string => Boolean(r));

            context = selectPrReviewContext({
              comments: currentComments,
              attempt: contextLevel,
              snapshot,
              previousBuildErrors: buildErrorsArray,
              previousVerifierReasons: verifierReasonsArray,
            });
          } catch (error: unknown) {
            d.onWarning?.(
              'context selection failed; falling back to per-comment processing',
              { reason: error instanceof Error ? error.message : String(error) },
              String(input.runId),
            );
            context = {
              level: contextLevel,
              sections: [],
              includedFiles: Array.from(new Set(currentComments.map((c) => c.path))),
              includedHunks: [],
              includedSymbols: [],
              fullDiffIncluded: false,
            };
          }
        } else {
          context = {
            level: contextLevel,
            sections: [],
            includedFiles: Array.from(new Set(currentComments.map((c) => c.path))),
            includedHunks: [],
            includedSymbols: [],
            fullDiffIncluded: false,
          };
        }

        d.onContextSelected?.({
          level: context.level,
          commentIds: currentComments.map((c) => c.commentId),
          includedFiles: context.includedFiles,
          includedHunks: context.includedHunks,
          includedSymbols: context.includedSymbols,
          fullDiffIncluded: context.fullDiffIncluded,
          ...(context.fallbackReason !== undefined
            ? { fallbackReason: context.fallbackReason }
            : {}),
        });

        const firstCommentId = currentComments[0]?.commentId;
        const batchPreviousBuildError =
          firstCommentId !== undefined ? perCommentBuildErrors[firstCommentId] : undefined;
        const batchPreviousVerifierReason =
          firstCommentId !== undefined ? perCommentVerifierReasons[firstCommentId] : undefined;

        let batchResult: PollBatchTaskOutput;
        try {
          batchResult = await taskRunner.executeBatch({
            ...input,
            comments: currentComments,
            diff: currentDiff,
            branch: pr.headRefName,
            startCommitSha: itemLiveStartSha,
            originalStartCommitSha: originalStartCommitSha,
            unresolvedCommentCount: unresolved.length,
            ...(batchPreviousBuildError !== undefined
              ? { previousBuildError: batchPreviousBuildError }
              : {}),
            ...(batchPreviousVerifierReason !== undefined
              ? { previousCodeVerifyReason: batchPreviousVerifierReason }
              : {}),
            reviewMode,
            retryNumber: attempt,
            dispositions,
            contextLevel: context.level,
            contextFiles: [...context.includedFiles],
            fullDiffIncluded: context.fullDiffIncluded,
            selectedContext: context,
          });
        } catch {
          batchResult = {
            outputs: currentComments.map((c) => ({
              commentId: c.commentId,
              action: 'failed' as const,
              processed: false,
              blocked: false,
            })),
            retryDisposition: currentComments.length > 1 ? 'split' : undefined,
          };
        }

        taskResults.push(...batchResult.outputs);

        for (const output of batchResult.outputs) {
          if (output.buildError !== undefined) {
            perCommentBuildErrors[output.commentId] = output.buildError;
          }
          if (output.codeVerifyReason !== undefined) {
            perCommentVerifierReasons[output.commentId] = output.codeVerifyReason;
          }
        }

        const allDone = batchResult.outputs.every(
          (o) => o.processed || o.blocked || o.action === 'no_fix',
        );
        if (allDone) {
          runningStartSha = await d.git.headCommitSha(input.cwd);
          continue;
        }

        // Split multi-comment batch failure into singletons at next attempt
        if (batchResult.retryDisposition === 'split' && attempt < ESCALATION_BUDGET) {
          for (const comment of currentComments) {
            const commentOutput = batchResult.outputs.find(
              (o) => o.commentId === comment.commentId,
            );
            if (
              commentOutput &&
              !commentOutput.processed &&
              !commentOutput.blocked &&
              commentOutput.action !== 'no_fix'
            ) {
              workQueue.push({
                commentIds: [comment.commentId],
                attempt: (attempt + 1) as 1 | 2 | 3,
                batchStartSha: itemBatchStartSha,
                previousBuildErrors: { ...perCommentBuildErrors },
                previousVerifierReasons: { ...perCommentVerifierReasons },
              });
            }
          }
          runningStartSha = await d.git.headCommitSha(input.cwd);
          continue;
        }

        // Singleton retry at next attempt
        if (currentComments.length === 1 && attempt < ESCALATION_BUDGET) {
          const comment = currentComments[0]!;
          const commentOutput = batchResult.outputs.find((o) => o.commentId === comment.commentId);
          if (
            commentOutput &&
            !commentOutput.processed &&
            !commentOutput.blocked &&
            commentOutput.action !== 'no_fix'
          ) {
            workQueue.push({
              commentIds: [comment.commentId],
              attempt: (attempt + 1) as 1 | 2 | 3,
              batchStartSha: itemBatchStartSha,
              previousBuildErrors: { ...perCommentBuildErrors },
              previousVerifierReasons: { ...perCommentVerifierReasons },
            });
          }
          runningStartSha = await d.git.headCommitSha(input.cwd);
          continue;
        }

        // Attempt budget exhausted (attempt === ESCALATION_BUDGET)
        if (attempt === ESCALATION_BUDGET) {
          const unresolvedOutputs = batchResult.outputs.filter(
            (o) => !o.processed && !o.blocked && o.action !== 'no_fix',
          );

          for (const output of unresolvedOutputs) {
            const comment = currentComments.find((c) => c.commentId === output.commentId);
            if (!comment) continue;
            let fallbackReason = `task failed after ${ESCALATION_BUDGET} attempts`;
            if (output.codeVerifyReason !== undefined) {
              fallbackReason = `verified incorrect: ${output.codeVerifyReason}`;
            } else if (output.buildError !== undefined) {
              fallbackReason = `code verified correct but build failing: ${output.buildError}`;
            }
            d.prReviewRepo.upsertComment(blockComment(comment, fallbackReason));
            output.blocked = true;
          }

          if (unresolvedOutputs.length > 0) {
            const rollbackOk = await d.rollbackFix?.(
              { cwd: input.cwd, branch: pr.headRefName },
              activeBatchStartSha,
            );
            if (rollbackOk === false) {
              d.onWarning?.(
                'rollbackFix failed: broken commits may remain on remote branch',
                { branch: pr.headRefName, cwd: input.cwd, targetSha: activeBatchStartSha },
                String(input.runId),
              );
            }
          }
          runningStartSha = await d.git.headCommitSha(input.cwd);
          continue;
        }
      } else {
        // Singleton processing path (single comment)
        for (const currentComment of currentComments) {
          let context: SelectedPrReviewContext | undefined;
          const contextLevel = Math.min(
            attempt,
            3,
          ) as import('./context-selector.js').PrReviewContextLevel;

          const commentPreviousBuildError = perCommentBuildErrors[currentComment.commentId];
          const commentPreviousVerifierReason = perCommentVerifierReasons[currentComment.commentId];

          if (d.contextSource) {
            try {
              const snapshot = await d.contextSource({
                cwd: input.cwd,
                base: 'origin/HEAD',
                head: itemLiveStartSha,
                seedPaths: [currentComment.path],
              });

              context = selectPrReviewContext({
                comments: [currentComment],
                attempt: contextLevel,
                snapshot,
                previousBuildErrors: commentPreviousBuildError ? [commentPreviousBuildError] : [],
                previousVerifierReasons: commentPreviousVerifierReason
                  ? [commentPreviousVerifierReason]
                  : [],
              });
            } catch (error: unknown) {
              d.onWarning?.(
                'context selection failed; falling back to per-comment processing',
                { reason: error instanceof Error ? error.message : String(error) },
                String(input.runId),
              );
            }
          }

          if (context) {
            d.onContextSelected?.({
              level: context.level,
              commentIds: [currentComment.commentId],
              includedFiles: context.includedFiles,
              includedHunks: context.includedHunks,
              includedSymbols: context.includedSymbols,
              fullDiffIncluded: context.fullDiffIncluded,
              ...(context.fallbackReason !== undefined
                ? { fallbackReason: context.fallbackReason }
                : {}),
            });
          }

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
              startCommitSha: itemLiveStartSha,
              originalStartCommitSha: originalStartCommitSha,
              unresolvedCommentCount: unresolved.length,
              reviewMode,
              retryNumber: attempt,
              dispositions: commentPreviousAttempts.map((a) => {
                const disposition = String(a.disposition ?? 'failure');
                const reason = a.verifierFeedback ?? a.buildFeedback;
                return {
                  fingerprint: a.attemptId,
                  disposition,
                  ...(reason !== undefined ? { reason } : {}),
                };
              }),
              ...(context
                ? {
                    contextLevel: context.level,
                    contextFiles: [...context.includedFiles],
                    fullDiffIncluded: context.fullDiffIncluded,
                    selectedContext: context,
                  }
                : {}),
              ...(commentPreviousBuildError !== undefined
                ? { previousBuildError: commentPreviousBuildError }
                : {}),
              ...(commentPreviousVerifierReason !== undefined
                ? { previousCodeVerifyReason: commentPreviousVerifierReason }
                : {}),
            });
            if (lastOutput.processed || lastOutput.blocked || lastOutput.action === 'no_fix') {
              if (lastOutput.buildError !== undefined) {
                perCommentBuildErrors[currentComment.commentId] = lastOutput.buildError;
              }
              if (lastOutput.codeVerifyReason !== undefined) {
                perCommentVerifierReasons[currentComment.commentId] = lastOutput.codeVerifyReason;
              }
              runningStartSha = await d.git.headCommitSha(input.cwd);
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
            perCommentBuildErrors[currentComment.commentId] = lastOutput.buildError;
          }
          if (lastOutput.codeVerifyReason !== undefined) {
            perCommentVerifierReasons[currentComment.commentId] = lastOutput.codeVerifyReason;
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
              activeBatchStartSha,
            );
            if (rollbackOk === false) {
              d.onWarning?.(
                'rollbackFix failed: broken commits may remain on remote branch',
                { branch: pr.headRefName, cwd: input.cwd, targetSha: activeBatchStartSha },
                String(input.runId),
              );
            }
            lastOutput = {
              commentId: currentComment.commentId,
              action: 'failed',
              processed: false,
              blocked: true,
            };
          } else if (attempt < ESCALATION_BUDGET) {
            workQueue.push({
              commentIds: [currentComment.commentId],
              attempt: (attempt + 1) as 1 | 2 | 3,
              batchStartSha: itemBatchStartSha,
              previousBuildErrors: { ...perCommentBuildErrors },
              previousVerifierReasons: { ...perCommentVerifierReasons },
            });
          }
          if (lastOutput) {
            taskResults.push(lastOutput);
          }
        }

        runningStartSha = await d.git.headCommitSha(input.cwd);
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
