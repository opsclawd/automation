import type { PrReviewComment } from '@ai-sdlc/domain';
import type { GitHubPort } from '../ports/github-port.js';
import type { GitPort } from '../ports/git-port.js';
import type { VerifyCodeChangeFn } from './verify-code-change.js';

export interface VerificationResult {
  ok: boolean;
  replyVerified: boolean;
  commitVerified: boolean;
  buildVerified: boolean;
  codeVerified: boolean;
  reason: string;
  buildError?: string;
  codeVerifyReason?: string;
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
    verifyBuildPasses: (input: {
      cwd: string;
      runId: string;
    }) => Promise<{ passed: boolean; error?: string }>;
    verifyCodeChange?: VerifyCodeChangeFn;
  },
  context: {
    cwd: string;
    branch: string;
    prNumber: number;
    repoFullName: string;
    startCommitSha: string | undefined;
    repoId?: string;
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
      codeVerified: true,
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
      codeVerified: true,
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

  const buildResult = await deps.verifyBuildPasses({
    cwd: context.cwd,
    runId: String(comment.runId),
  });
  buildVerified = buildResult.passed;
  const buildError = buildResult.error;

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

  // Semantic code verification — only when all mechanical checks pass
  let codeVerified = true;
  let codeVerifyReason: string | undefined;

  const mechanicalOk =
    fixCommitOnRemote && isNewerThanStart && commitVerified && replyVerified && buildVerified;

  if (mechanicalOk && deps.verifyCodeChange && comment.commitSha) {
    const codeResult = await deps.verifyCodeChange({
      commentBody: comment.body,
      path: comment.path,
      line: comment.line,
      cwd: context.cwd,
      startCommitSha: context.startCommitSha ?? '',
      fixCommitSha: comment.commitSha,
      runId: String(comment.runId),
      repoId: context.repoId ?? String(comment.runId),
    });
    codeVerified = codeResult.pass;
    if (!codeResult.pass) {
      codeVerifyReason = codeResult.reason;
      failReason = `code verification failed: ${codeResult.reason}`;
    }
  }

  const ok = mechanicalOk && codeVerified;

  return {
    ok,
    replyVerified,
    commitVerified,
    buildVerified,
    codeVerified,
    reason: ok ? '' : failReason,
    ...(buildError !== undefined ? { buildError } : {}),
    ...(codeVerifyReason !== undefined ? { codeVerifyReason } : {}),
  };
}
