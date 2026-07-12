import * as fs from 'fs';
import * as path from 'path';
import type { PrReviewComment, PrReviewCommentAttempt } from '@ai-sdlc/domain';
import { markProcessed, blockComment, markReplied } from '@ai-sdlc/domain';
import type { RunId, RepositoryId, PhaseName } from '@ai-sdlc/domain';
import type { GitHubPort } from '../ports/github-port.js';
import type { GitPort } from '../ports/git-port.js';
import type { AgentPort } from '../ports/agent-port.js';
import type { AgentProfileName } from '../ports/agent-invocation-types.js';
import type { PrReviewRepositoryPort } from '../ports/pr-review-repository-port.js';
import type { PollTaskResult } from '../results/schemas/poll-task-result.js';
import type { VerifyCodeChangeFn } from './verify-code-change.js';
import { verifyComment } from './verify-comment.js';

export interface PollTaskRunnerDeps {
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
    mode: PostPrReviewAttemptMode;
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
  resolveProfileForPhase: (phaseName: string) => AgentProfileName;
  idFactory: () => string;
  now: () => Date;
}

export type PostPrReviewAttemptMode = 'initial_full' | 'intermediate_delta';

export interface PollTaskInput {
  runId: RunId;
  repoId: RepositoryId;
  repoFullName: string;
  prNumber: number;
  cwd: string;
  phaseId: PhaseName;
  pollNumber: number;
  comment: PrReviewComment;
  diff: string;
  branch: string;
  startCommitSha: string;
  originalStartCommitSha: string;
  unresolvedCommentCount: number;
  previousBuildError?: string;
  previousCodeVerifyReason?: string;
  reviewMode: PostPrReviewAttemptMode;
  retryNumber: number;
  dispositions?: Array<{
    fingerprint: string;
    disposition: string;
    reason?: string;
  }>;
}

export interface PollTaskOutput {
  commentId: number;
  action: 'fixed' | 'no_fix' | 'blocked' | 'failed';
  processed: boolean;
  blocked: boolean;
  buildError?: string;
  codeVerifyReason?: string;
  attemptId?: string;
}

export class PollTaskRunner {
  constructor(private readonly deps: PollTaskRunnerDeps) {}

  async execute(input: PollTaskInput): Promise<PollTaskOutput> {
    const d = this.deps;
    const { comment } = input;
    const attemptId = d.idFactory();
    const currentHeadBeforeReset = await d.git.headCommitSha(input.cwd);

    const attempt: PrReviewCommentAttempt = {
      attemptId,
      runId: input.runId,
      commentId: comment.commentId,
      retryNumber: input.retryNumber,
      startHead: input.startCommitSha,
      completedHead: currentHeadBeforeReset,
      reviewMode: input.reviewMode,
      promptPath: '',
      resultArtifactPath: '',
      action: 'review',
      createdAt: d.now(),
    };
    d.prReviewRepo.appendCommentAttempt(attempt);

    try {
      await d.git.resetHard(input.cwd, input.startCommitSha);
      await d.git.cleanUntracked(input.cwd);

      // 1. Render single-comment prompt
      const promptPath = await d.renderTaskPrompt({
        cwd: input.cwd,
        comment: input.comment,
        diff: input.diff,
        branch: input.branch,
        mode: input.reviewMode,
        ...(input.previousBuildError !== undefined
          ? { previousBuildError: input.previousBuildError }
          : {}),
        ...(input.previousCodeVerifyReason !== undefined
          ? { previousCodeVerifyReason: input.previousCodeVerifyReason }
          : {}),
        ...(input.dispositions !== undefined ? { dispositions: input.dispositions } : {}),
      });
      attempt.promptPath = promptPath;

      const completedHeadAfterPrompt = await d.git.headCommitSha(input.cwd);
      attempt.completedHead = completedHeadAfterPrompt;
      d.prReviewRepo.updateCommentAttempt(attempt);

      // 2. Invoke agent
      let invocation: Awaited<ReturnType<AgentPort['invoke']>>;
      const profile = d.resolveProfileForPhase('post-pr-review');
      const timeoutMs = Math.min(30, 10 + 5 * input.unresolvedCommentCount) * 60_000;
      invocation = await d.agent.invoke({
        profile,
        promptPath,
        expectedArtifacts: ['result.json'],
        cwd: input.cwd,
        runId: String(input.runId),
        repoId: String(input.repoId),
        phaseId: String(input.phaseId),
        startCommitSha: input.startCommitSha,
        timeoutMs,
        metadata: {
          pr_review_comment_id: comment.commentId,
          invocation_type:
            input.previousBuildError || input.previousCodeVerifyReason ? 'retry' : 'initial',
          review_mode: input.reviewMode,
          review_snapshot_kind: 'git',
          review_snapshot_identity: completedHeadAfterPrompt,
          review_base_identity: undefined,
          review_dimensions: ['post-pr-review'],
          review_scope_source: 'post-pr-review',
        },
      });

      let resultArtifactPath = invocation.resultJsonPath ?? '';
      if (resultArtifactPath) {
        const srcPath = path.isAbsolute(resultArtifactPath)
          ? resultArtifactPath
          : path.join(input.cwd, resultArtifactPath);
        if (fs.existsSync(srcPath)) {
          const durableDir = attempt.promptPath
            ? path.dirname(attempt.promptPath)
            : path.join(input.cwd, '.ai-pr-review');
          fs.mkdirSync(durableDir, { recursive: true });
          const durableFileName = `result-${attemptId}-${path.basename(resultArtifactPath)}`;
          const destPath = path.join(durableDir, durableFileName);
          try {
            fs.copyFileSync(srcPath, destPath);
            resultArtifactPath = destPath;
          } catch {
            // ignore / handle
          }
        }
      }
      attempt.resultArtifactPath = resultArtifactPath;
      d.prReviewRepo.updateCommentAttempt(attempt);

      if (invocation.outcome !== 'success') {
        const currentHead = await d.git.headCommitSha(input.cwd);
        attempt.completedHead = currentHead;
        attempt.disposition = 'failure';
        attempt.action = 'review';
        d.prReviewRepo.updateCommentAttempt(attempt);
        return {
          commentId: comment.commentId,
          action: 'failed',
          processed: false,
          blocked: false,
          attemptId,
        };
      }

      // 3. Extract result
      const extracted = await d.extractTaskResult(
        invocation.resultJsonPath !== undefined
          ? { resultJsonPath: invocation.resultJsonPath, cwd: input.cwd }
          : { cwd: input.cwd },
      );

      if (!extracted.ok) {
        const currentHead = await d.git.headCommitSha(input.cwd);
        attempt.completedHead = currentHead;
        attempt.disposition = 'failure';
        attempt.action = 'review';
        d.prReviewRepo.updateCommentAttempt(attempt);
        return {
          commentId: comment.commentId,
          action: 'failed',
          processed: false,
          blocked: false,
          attemptId,
        };
      }

      const result = extracted.result;

      if (result.commentId !== comment.commentId) {
        const currentHead = await d.git.headCommitSha(input.cwd);
        attempt.completedHead = currentHead;
        attempt.disposition = 'failure';
        attempt.action = 'review';
        d.prReviewRepo.updateCommentAttempt(attempt);
        return {
          commentId: comment.commentId,
          action: 'failed',
          processed: false,
          blocked: false,
          attemptId,
        };
      }

      if (result.action === 'blocked') {
        await this.postReplyIfMissing(input, result.replyBody);
        d.prReviewRepo.insertReply({
          id: d.idFactory(),
          runId: input.runId,
          prNumber: input.prNumber,
          commentId: comment.commentId,
          body: result.replyBody,
          postedAt: d.now(),
          verified: true,
        });
        d.prReviewRepo.upsertComment(
          blockComment(comment, result.blockedReason ?? 'agent blocked'),
        );
        const currentHead = await d.git.headCommitSha(input.cwd);
        attempt.completedHead = currentHead;
        attempt.disposition = 'failure';
        attempt.action = 'remediate';
        if (result.blockedReason !== undefined) {
          attempt.verifierFeedback = result.blockedReason;
        }
        d.prReviewRepo.updateCommentAttempt(attempt);
        return {
          commentId: comment.commentId,
          action: 'blocked',
          processed: false,
          blocked: true,
          attemptId,
        };
      }

      if (result.action === 'no_fix') {
        const githubReplyId = await this.postReplyIfMissing(input, result.replyBody);
        const replyRecordId = d.idFactory();
        d.prReviewRepo.insertReply({
          id: replyRecordId,
          runId: input.runId,
          prNumber: input.prNumber,
          commentId: comment.commentId,
          body: result.replyBody,
          postedAt: d.now(),
          verified: true,
        });

        const replied = markReplied(comment, {
          replyId: githubReplyId,
          outcome: 'no_fix',
          poll: input.pollNumber,
        });
        d.prReviewRepo.upsertComment(replied);

        attempt.action = 'verify';
        const verification = await verifyComment(replied, d, {
          cwd: input.cwd,
          branch: input.branch,
          prNumber: input.prNumber,
          repoFullName: input.repoFullName,
          originalStartCommitSha: input.originalStartCommitSha,
          runningStartSha: input.startCommitSha,
          repoId: String(input.repoId),
        });

        if (verification.ok) {
          d.prReviewRepo.upsertComment(
            markProcessed(replied, {
              commitVerified: verification.commitVerified,
              replyVerified: verification.replyVerified,
              buildVerified: verification.buildVerified,
            }),
          );
          await d.github.resolveReviewThread(input.repoFullName, input.prNumber, comment.commentId);
          const currentHead = await d.git.headCommitSha(input.cwd);
          attempt.completedHead = currentHead;
          attempt.disposition = 'success';
          attempt.action = 'remediate';
          d.prReviewRepo.updateCommentAttempt(attempt);
          return {
            commentId: comment.commentId,
            action: 'no_fix',
            processed: true,
            blocked: false,
            attemptId,
          };
        }

        const currentHeadNoFix = await d.git.headCommitSha(input.cwd);
        attempt.completedHead = currentHeadNoFix;
        attempt.disposition = 'failure';
        attempt.action = 'verify';
        attempt.verifierFeedback = 'reply verification failed';
        d.prReviewRepo.updateCommentAttempt(attempt);
        return {
          commentId: comment.commentId,
          action: 'no_fix',
          processed: false,
          blocked: false,
          attemptId,
        };
      }

      if (result.action === 'fixed') {
        const fixCommitSha = await d.git.headCommitSha(input.cwd);
        if (fixCommitSha === input.startCommitSha) {
          const currentHead = await d.git.headCommitSha(input.cwd);
          attempt.completedHead = currentHead;
          attempt.disposition = 'failure';
          attempt.action = 'remediate';
          attempt.buildFeedback = 'agent did not produce a new commit (commitSha unchanged)';
          d.prReviewRepo.updateCommentAttempt(attempt);
          await this.resetToStart(input);
          return {
            commentId: comment.commentId,
            action: 'fixed',
            processed: false,
            blocked: false,
            buildError: 'agent did not produce a new commit (commitSha unchanged)',
            attemptId,
          };
        }

        attempt.action = 'remediate';
        const buildResult = await d.verifyBuildPasses({
          cwd: input.cwd,
          runId: String(input.runId),
        });
        if (!buildResult.passed) {
          const currentHead = await d.git.headCommitSha(input.cwd);
          attempt.completedHead = currentHead;
          attempt.disposition = 'failure';
          attempt.action = 'remediate';
          if (buildResult.error !== undefined) {
            attempt.buildFeedback = buildResult.error;
          }
          d.prReviewRepo.updateCommentAttempt(attempt);
          await this.resetToStart(input);
          return {
            commentId: comment.commentId,
            action: 'fixed',
            processed: false,
            blocked: false,
            ...(buildResult.error !== undefined ? { buildError: buildResult.error } : {}),
            attemptId,
          };
        }

        attempt.action = 'verify';
        if (d.verifyCodeChange) {
          const codeResult = await d.verifyCodeChange({
            commentBody: comment.body,
            path: comment.path,
            line: comment.line,
            cwd: input.cwd,
            startCommitSha: input.startCommitSha,
            fixCommitSha,
            runId: String(input.runId),
            repoId: String(input.repoId),
          });
          if (!codeResult.pass) {
            const currentHead = await d.git.headCommitSha(input.cwd);
            attempt.completedHead = currentHead;
            attempt.disposition = 'failure';
            attempt.action = 'verify';
            attempt.verifierFeedback = codeResult.reason;
            d.prReviewRepo.updateCommentAttempt(attempt);
            await this.resetToStart(input);
            return {
              commentId: comment.commentId,
              action: 'fixed',
              processed: false,
              blocked: false,
              codeVerifyReason: codeResult.reason,
              attemptId,
            };
          }
        }

        await d.git.push({ cwd: input.cwd, branch: input.branch });

        const githubReplyId = await this.postReplyIfMissing(input, result.replyBody);
        const replyRecordId = d.idFactory();
        d.prReviewRepo.insertReply({
          id: replyRecordId,
          runId: input.runId,
          prNumber: input.prNumber,
          commentId: comment.commentId,
          body: result.replyBody,
          postedAt: d.now(),
          verified: true,
        });

        const replied = markReplied(comment, {
          replyId: githubReplyId,
          outcome: 'fixed',
          commitSha: fixCommitSha,
          poll: input.pollNumber,
        });
        d.prReviewRepo.upsertComment(replied);

        const verification = await verifyComment(replied, d, {
          cwd: input.cwd,
          branch: input.branch,
          prNumber: input.prNumber,
          repoFullName: input.repoFullName,
          originalStartCommitSha: input.originalStartCommitSha,
          runningStartSha: input.startCommitSha,
          repoId: String(input.repoId),
        });

        if (verification.ok) {
          d.prReviewRepo.upsertComment(
            markProcessed(replied, {
              commitVerified: verification.commitVerified,
              replyVerified: verification.replyVerified,
              buildVerified: verification.buildVerified,
            }),
          );
          await d.github.resolveReviewThread(input.repoFullName, input.prNumber, comment.commentId);
          const currentHead = await d.git.headCommitSha(input.cwd);
          attempt.completedHead = currentHead;
          attempt.disposition = 'success';
          attempt.action = 'remediate';
          d.prReviewRepo.updateCommentAttempt(attempt);
          return {
            commentId: comment.commentId,
            action: 'fixed',
            processed: true,
            blocked: false,
            attemptId,
          };
        }

        const currentHeadFixed = await d.git.headCommitSha(input.cwd);
        attempt.completedHead = currentHeadFixed;
        attempt.disposition = 'failure';
        attempt.action = 'verify';
        attempt.verifierFeedback =
          verification.buildError ?? verification.codeVerifyReason ?? 'verification failed';
        d.prReviewRepo.updateCommentAttempt(attempt);
        return {
          commentId: comment.commentId,
          action: 'fixed',
          processed: false,
          blocked: false,
          ...(verification.buildError !== undefined ? { buildError: verification.buildError } : {}),
          ...(verification.codeVerifyReason !== undefined
            ? { codeVerifyReason: verification.codeVerifyReason }
            : {}),
          attemptId,
        };
      }

      const fallbackHead = await d.git.headCommitSha(input.cwd);
      attempt.completedHead = fallbackHead;
      attempt.disposition = 'failure';
      attempt.action = 'review';
      d.prReviewRepo.updateCommentAttempt(attempt);
      return {
        commentId: comment.commentId,
        action: 'failed',
        processed: false,
        blocked: false,
        attemptId,
      };
    } catch (err) {
      const currentHead = await d.git.headCommitSha(input.cwd);
      attempt.completedHead = currentHead;
      attempt.disposition = 'failure';
      d.prReviewRepo.updateCommentAttempt(attempt);
      await this.resetToStart(input);
      throw err;
    }
  }

  private async resetToStart(input: PollTaskInput): Promise<void> {
    await this.deps.git.resetHard(input.cwd, input.startCommitSha);
    await this.deps.git.cleanUntracked(input.cwd);
  }

  private async postReplyIfMissing(input: PollTaskInput, body: string): Promise<number> {
    const repliesBefore = await this.deps.github.listReviewComments(
      input.repoFullName,
      input.prNumber,
    );
    const existingReply = repliesBefore.find((c) => c.inReplyToId === input.comment.commentId);
    if (existingReply) {
      return existingReply.id;
    }

    const newReply = await this.deps.github.replyToReviewComment(
      input.repoFullName,
      input.prNumber,
      input.comment.commentId,
      body,
    );

    return newReply.id;
  }
}
