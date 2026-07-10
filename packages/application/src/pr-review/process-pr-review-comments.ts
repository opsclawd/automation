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
import { verifyComment } from './verify-comment.js';
import type { VerifyCodeChangeFn } from './verify-code-change.js';
import type { FixDiffInspectorPort } from '../ports/fix-diff-inspector-port.js';
import type { GitHubPort } from '../ports/github-port.js';
import type { GitPort } from '../ports/git-port.js';
import type { AgentPort } from '../ports/agent-port.js';
import type { AgentProfileName } from '../ports/agent-invocation-types.js';
import type { PrReviewRepositoryPort } from '../ports/pr-review-repository-port.js';
import type { PollTaskResult } from '../results/schemas/poll-task-result.js';
import { PollTaskRunner } from './poll-task-runner.js';
import type { PollTaskOutput } from './poll-task-runner.js';

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
    previousBuildError?: string;
    previousCodeVerifyReason?: string;
  }) => Promise<string>;
  extractTaskResult: (input: {
    resultJsonPath?: string;
    cwd: string;
  }) => Promise<
    { ok: true; result: PollTaskResult } | { ok: false; reason: string; detail: string }
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
  baseBranch?: string;
  repoRoot?: string | undefined;
  onWarning?: (message: string, metadata: Record<string, unknown>, runId: string) => void;
  rollbackFix?: (ctx: { cwd: string; branch: string }, targetSha: string) => Promise<boolean>;
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

    const diff = await d.git.diff(input.cwd, 'origin/HEAD');
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
    // Each task's agent may commit, advancing HEAD. Later tasks must verify
    // against the HEAD as of when they start, not the stale poll-start SHA. (M1)
    let runningStartSha = startCommitSha;

    for (const task of manifest.tasks) {
      // Re-read live state: a comment may have been resolved or blocked since the
      // manifest was built (e.g. by a prior poll's orphan verification). Only
      // process comments that are still pending. (M2)
      const comment = d.prReviewRepo.getComment(input.runId, task.commentId);
      if (!comment || comment.state !== 'pending') continue;

      runningStartSha = await d.git.headCommitSha(input.cwd);

      let lastOutput: PollTaskOutput | undefined;
      let previousBuildError: string | undefined;
      let previousCodeVerifyReason: string | undefined;
      for (let attempt = 1; attempt <= ESCALATION_BUDGET; attempt++) {
        const currentComment = d.prReviewRepo.getComment(input.runId, task.commentId);
        if (!currentComment) break;
        if (currentComment.state !== 'pending' && currentComment.state !== 'replied') break;

        const currentDiff = attempt === 1 ? diff : await d.git.diff(input.cwd, 'origin/HEAD');
        try {
          lastOutput = await taskRunner.execute({
            ...input,
            comment: currentComment,
            diff: currentDiff,
            branch: pr.headRefName,
            startCommitSha: runningStartSha,
            originalStartCommitSha: originalStartCommitSha,
            unresolvedCommentCount: unresolved.length,
            ...(previousBuildError !== undefined ? { previousBuildError } : {}),
            ...(previousCodeVerifyReason !== undefined ? { previousCodeVerifyReason } : {}),
          });
          if (lastOutput.processed || lastOutput.blocked || lastOutput.action === 'no_fix') break;
        } catch {
          lastOutput = {
            commentId: task.commentId,
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
        const isFinalAttempt = attempt === ESCALATION_BUDGET;
        const willVerifyFinal =
          isFinalAttempt && lastOutput && !lastOutput.processed && !lastOutput.blocked;

        if (willVerifyFinal && lastOutput) {
          const currentComment = d.prReviewRepo.getComment(input.runId, task.commentId);
          if (currentComment && currentComment.state === 'replied') {
            const verification = await verifyComment(currentComment, d, {
              cwd: input.cwd,
              branch: pr.headRefName,
              prNumber: input.prNumber,
              repoFullName: input.repoFullName,
              originalStartCommitSha,
              runningStartSha,
              ...(input.runId ? { repoId: String(input.runId) } : {}),
              commentId: currentComment.commentId,
            });
            if (verification.ok) {
              d.prReviewRepo.upsertComment(
                markProcessed(currentComment, {
                  commitVerified: verification.commitVerified,
                  replyVerified: verification.replyVerified,
                  buildVerified: verification.buildVerified,
                }),
              );
              await d.github.resolveReviewThread(
                input.repoFullName,
                input.prNumber,
                currentComment.commentId,
              );
              lastOutput = {
                commentId: task.commentId,
                action: 'fixed',
                processed: true,
                blocked: false,
              };
            } else {
              const reason = this.translateBlockReason(
                verification,
                currentComment,
                ESCALATION_BUDGET,
              );
              d.prReviewRepo.upsertComment(blockComment(currentComment, reason));
              if (verification.codeVerified) {
                // Code is OK but build failing — undo the work so a future poll
                // can attempt with a clean tree.
                await d.rollbackFix?.({ cwd: input.cwd, branch: pr.headRefName }, runningStartSha);
              }
              lastOutput = {
                commentId: task.commentId,
                action: 'failed',
                processed: false,
                blocked: true,
              };
            }
          }
        }
        if (
          attempt === ESCALATION_BUDGET &&
          lastOutput &&
          !lastOutput.processed &&
          !lastOutput.blocked
        ) {
          // No verifier produced a result (e.g. agent crashed, no commit to
          // anchor against). Keep the original generic-fallback behavior.
          const rollbackOk = await d.rollbackFix?.(
            { cwd: input.cwd, branch: pr.headRefName },
            runningStartSha,
          );
          if (rollbackOk === false) {
            d.onWarning?.(
              'rollbackFix failed: broken commits may remain on remote branch',
              {
                branch: pr.headRefName,
                cwd: input.cwd,
                targetSha: runningStartSha,
              },
              String(input.runId),
            );
          }
          // Prefer the last attempt's concrete verification failure over the
          // generic reason — pre-push verify failures never reach 'replied'
          // state, so the final verifyComment pass above is skipped and this
          // branch is where their outcome must be surfaced (#629).
          let fallbackReason = `task failed after ${ESCALATION_BUDGET} attempts`;
          if (lastOutput.codeVerifyReason !== undefined) {
            fallbackReason = `verified incorrect: ${lastOutput.codeVerifyReason}`;
          } else if (lastOutput.buildError !== undefined) {
            fallbackReason = `build failed: ${lastOutput.buildError}`;
          }
          d.prReviewRepo.upsertComment(blockComment(currentComment!, fallbackReason));
          lastOutput = {
            commentId: task.commentId,
            action: 'failed',
            processed: false,
            blocked: true,
          };
        }
      }
      if (lastOutput) {
        taskResults.push(lastOutput);
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
  ): import('../results/schemas/poll-task-manifest.js').PollTaskManifest {
    return {
      version: 1,
      taskCount: comments.length,
      tasks: comments.map((c, i) => ({
        id: `comment-${c.commentId}`,
        commentId: c.commentId,
        path: c.path,
        line: c.line,
        body: c.body,
        reviewer: c.reviewer,
        priority: i + 1,
      })),
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
