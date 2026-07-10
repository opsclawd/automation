import type { PrReviewComment } from '@ai-sdlc/domain';
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
}

export interface PollTaskOutput {
  commentId: number;
  action: 'fixed' | 'no_fix' | 'blocked' | 'failed';
  processed: boolean;
  blocked: boolean;
  buildError?: string;
  codeVerifyReason?: string;
}

export class PollTaskRunner {
  constructor(private readonly deps: PollTaskRunnerDeps) {}

  async execute(input: PollTaskInput): Promise<PollTaskOutput> {
    const d = this.deps;
    const { comment } = input;

    await d.git.resetHard(input.cwd, input.startCommitSha);
    await d.git.cleanUntracked(input.cwd);

    // 1. Render single-comment prompt
    const promptPath = await d.renderTaskPrompt({
      cwd: input.cwd,
      comment: input.comment,
      diff: input.diff,
      branch: input.branch,
      ...(input.previousBuildError !== undefined
        ? { previousBuildError: input.previousBuildError }
        : {}),
      ...(input.previousCodeVerifyReason !== undefined
        ? { previousCodeVerifyReason: input.previousCodeVerifyReason }
        : {}),
    });

    // 2. Invoke agent
    const profile = d.resolveProfileForPhase('post-pr-review');
    const timeoutMs = Math.min(30, 10 + 5 * input.unresolvedCommentCount) * 60_000;
    const invocation = await d.agent.invoke({
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
        invocation_type: input.previousBuildError || input.previousCodeVerifyReason ? 'retry' : 'initial',
      },
    });

    if (invocation.outcome !== 'success') {
      return {
        commentId: comment.commentId,
        action: 'failed',
        processed: false,
        blocked: false,
      };
    }

    // 3. Extract result
    const extracted = await d.extractTaskResult(
      invocation.resultJsonPath !== undefined
        ? { resultJsonPath: invocation.resultJsonPath, cwd: input.cwd }
        : { cwd: input.cwd },
    );

    if (!extracted.ok) {
      return {
        commentId: comment.commentId,
        action: 'failed',
        processed: false,
        blocked: false,
      };
    }

    const result = extracted.result;

    if (result.commentId !== comment.commentId) {
      return {
        commentId: comment.commentId,
        action: 'failed',
        processed: false,
        blocked: false,
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
      d.prReviewRepo.upsertComment(blockComment(comment, result.blockedReason ?? 'agent blocked'));
      return {
        commentId: comment.commentId,
        action: 'blocked',
        processed: false,
        blocked: true,
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
        return {
          commentId: comment.commentId,
          action: 'no_fix',
          processed: true,
          blocked: false,
        };
      }

      return {
        commentId: comment.commentId,
        action: 'no_fix',
        processed: false,
        blocked: false,
      };
    }

    if (result.action === 'fixed') {
      const fixCommitSha = await d.git.headCommitSha(input.cwd);
      if (fixCommitSha === input.startCommitSha) {
        await this.resetToStart(input);
        return {
          commentId: comment.commentId,
          action: 'fixed',
          processed: false,
          blocked: false,
          buildError: 'agent did not produce a new commit (commitSha unchanged)',
        };
      }

      const buildResult = await d.verifyBuildPasses({
        cwd: input.cwd,
        runId: String(input.runId),
      });
      if (!buildResult.passed) {
        await this.resetToStart(input);
        return {
          commentId: comment.commentId,
          action: 'fixed',
          processed: false,
          blocked: false,
          ...(buildResult.error !== undefined ? { buildError: buildResult.error } : {}),
        };
      }

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
          await this.resetToStart(input);
          return {
            commentId: comment.commentId,
            action: 'fixed',
            processed: false,
            blocked: false,
            codeVerifyReason: codeResult.reason,
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
        return {
          commentId: comment.commentId,
          action: 'fixed',
          processed: true,
          blocked: false,
        };
      }

      return {
        commentId: comment.commentId,
        action: 'fixed',
        processed: false,
        blocked: false,
        ...(verification.buildError !== undefined ? { buildError: verification.buildError } : {}),
        ...(verification.codeVerifyReason !== undefined
          ? { codeVerifyReason: verification.codeVerifyReason }
          : {}),
      };
    }

    return {
      commentId: comment.commentId,
      action: 'failed',
      processed: false,
      blocked: false,
    };
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
