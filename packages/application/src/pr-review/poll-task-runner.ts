import type { PrReviewComment } from '@ai-sdlc/domain';
import { markProcessed, blockComment } from '@ai-sdlc/domain';
import type { RunId, RepositoryId, PhaseName } from '@ai-sdlc/domain';
import type { GitHubPort } from '../ports/github-port.js';
import type { GitPort } from '../ports/git-port.js';
import type { AgentPort } from '../ports/agent-port.js';
import type { AgentProfileName } from '../ports/agent-invocation-types.js';
import type { PrReviewRepositoryPort } from '../ports/pr-review-repository-port.js';
import type { PollTaskResult } from '../results/schemas/poll-task-result.js';
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
  verifyBuildPasses: (input: { cwd: string; runId: string }) => Promise<boolean>;
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
  unresolvedCommentCount: number;
}

export interface PollTaskOutput {
  commentId: number;
  action: 'fixed' | 'no_fix' | 'blocked' | 'failed';
  processed: boolean;
  blocked: boolean;
}

export class PollTaskRunner {
  constructor(private readonly deps: PollTaskRunnerDeps) {}

  async execute(input: PollTaskInput): Promise<PollTaskOutput> {
    const d = this.deps;
    const { comment } = input;

    await d.git.resetHard(input.cwd, 'HEAD');
    await d.git.cleanUntracked(input.cwd);

    // 1. Render single-comment prompt
    const promptPath = await d.renderTaskPrompt({
      cwd: input.cwd,
      comment: input.comment,
      diff: input.diff,
      branch: input.branch,
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

    // 4. Post reply — idempotent. A comment can be reprocessed after a failed
    // verification (reset to pending on a later poll), so posting unconditionally
    // would accumulate one duplicate reply per attempt. Only post if this comment
    // has no reply on GitHub yet. (Finding H1)
    const repliesBefore = await d.github.listReviewComments(input.repoFullName, input.prNumber);
    const alreadyReplied = repliesBefore.some((c) => c.inReplyToId === comment.commentId);
    if (!alreadyReplied) {
      await d.github.replyToReviewComment(
        input.repoFullName,
        input.prNumber,
        comment.commentId,
        result.replyBody,
      );
    }

    if (result.action === 'blocked') {
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

    // 5. Capture fix commit SHA (verification delegated to shared verifyComment)
    let fixCommitSha: string | undefined;
    if (result.action === 'fixed') {
      fixCommitSha = await d.git.headCommitSha(input.cwd);
    }

    // 6. Mark replied
    const replied: PrReviewComment = {
      ...comment,
      state: 'replied',
      outcome: result.action === 'fixed' ? 'fixed' : 'no_fix',
      attempts: comment.attempts + 1,
      lastPoll: input.pollNumber,
      updatedAt: d.now(),
    };
    if (result.action === 'fixed' && fixCommitSha !== undefined) {
      replied.commitSha = fixCommitSha;
    }
    d.prReviewRepo.upsertComment(replied);

    // 7. Verify with shared function
    const verification = await verifyComment(replied, d, {
      cwd: input.cwd,
      branch: input.branch,
      prNumber: input.prNumber,
      repoFullName: input.repoFullName,
      startCommitSha: input.startCommitSha,
    });

    if (verification.ok) {
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
        markProcessed(replied, {
          commitVerified: verification.commitVerified,
          replyVerified: verification.replyVerified,
          buildVerified: verification.buildVerified,
        }),
      );
      await d.github.resolveReviewThread(input.repoFullName, input.prNumber, comment.commentId);
      return {
        commentId: comment.commentId,
        action: result.action,
        processed: true,
        blocked: false,
      };
    }

    // Verification failed — return as not processed (retry loop in caller handles this)
    return {
      commentId: comment.commentId,
      action: result.action,
      processed: false,
      blocked: false,
    };
  }
}
