import type { PrReviewComment } from '@ai-sdlc/domain';
import type { GitHubPort } from '../ports/github-port.js';
import type { GitPort } from '../ports/git-port.js';

export interface VerificationResult {
  ok: boolean;
  replyVerified: boolean;
  commitVerified: boolean;
  buildVerified: boolean;
  reason: string;
}

export async function verifyComment(
  comment: PrReviewComment,
  deps: {
    git: GitPort;
    github: GitHubPort;
    verifyCommitPushed: (input: {
      cwd: string;
      branch: string;
      startCommitSha: string;
      commitSha?: string;
    }) => Promise<boolean>;
    verifyBuildPasses: (input: { cwd: string; runId: string }) => Promise<boolean>;
  },
  context: {
    cwd: string;
    branch: string;
    prNumber: number;
    repoFullName: string;
    startCommitSha: string | undefined;
  },
): Promise<VerificationResult> {
  const afterComments = await deps.github.listReviewComments(
    context.repoFullName,
    context.prNumber,
  );
  const replyVerified = afterComments.some((c) => c.inReplyToId === comment.commentId);

  if (comment.outcome === 'no_fix') {
    return {
      ok: replyVerified,
      replyVerified,
      commitVerified: true,
      buildVerified: true,
      reason: replyVerified ? '' : 'reply not found on GitHub',
    };
  }

  let commitVerified = true;
  let buildVerified = true;
  let failReason = '';

  const commitShaChanged =
    comment.commitSha !== undefined && comment.commitSha !== context.startCommitSha;
  if (!commitShaChanged) {
    return {
      ok: false,
      replyVerified,
      commitVerified: false,
      buildVerified: false,
      reason: 'agent did not produce a new commit (commitSha unchanged)',
    };
  }

  if (comment.commitSha && context.startCommitSha) {
    commitVerified = await deps.verifyCommitPushed({
      cwd: context.cwd,
      branch: context.branch,
      startCommitSha: context.startCommitSha,
      commitSha: comment.commitSha,
    });
  } else if (comment.commitSha) {
    commitVerified = true;
  } else {
    commitVerified = false;
  }

  buildVerified = await deps.verifyBuildPasses({ cwd: context.cwd, runId: comment.runId });

  let fixCommitOnRemote = true;
  let isNewerThanStart = true;
  if (comment.commitSha) {
    const remoteSha = await deps.git.remoteRef({
      cwd: context.cwd,
      remote: 'origin',
      ref: context.branch,
    });
    if (remoteSha) {
      fixCommitOnRemote = await deps.git.isAncestor(context.cwd, comment.commitSha, remoteSha);
    } else {
      fixCommitOnRemote = false;
    }
    if (context.startCommitSha) {
      const commitsSinceStart = await deps.git.logBetween(
        context.cwd,
        context.startCommitSha,
        comment.commitSha,
      );
      isNewerThanStart = commitsSinceStart.length > 0;
    }
  }

  if (!replyVerified) failReason = 'reply not found on GitHub';
  else if (!fixCommitOnRemote && !failReason)
    failReason = 'fix commit is not an ancestor of remote branch tip';
  else if (!isNewerThanStart && !failReason)
    failReason = 'fix commit is not newer than start (logBetween empty)';
  else if (!commitVerified && !failReason) failReason = 'commit not pushed to remote';
  else if (!buildVerified && !failReason) failReason = 'build did not pass';

  const ok =
    fixCommitOnRemote && isNewerThanStart && commitVerified && replyVerified && buildVerified;

  return { ok, replyVerified, commitVerified, buildVerified, reason: ok ? '' : failReason };
}
