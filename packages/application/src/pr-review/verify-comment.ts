import type { PrReviewComment } from '@ai-sdlc/domain';
import type { GitHubPort } from '../ports/github-port.js';
import type { GitPort } from '../ports/git-port.js';
import type { VerifyCodeChangeFn } from './verify-code-change.js';
import type { FixDiffInspectorPort } from '../ports/fix-diff-inspector-port.js';

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

export async function verifyReplyPosted(
  deps: { github: GitHubPort },
  context: { repoFullName: string; prNumber: number },
  commentId: number,
): Promise<boolean> {
  const afterComments = await deps.github.listReviewComments(
    context.repoFullName,
    context.prNumber,
  );
  return afterComments.some((c) => c.inReplyToId === commentId);
}

export interface RemoteFixCommitVerification {
  commitVerified: boolean;
  fixCommitOnRemote: boolean;
  isNewerThanStart: boolean;
  reason: string;
}

export async function verifyRemoteFixCommit(
  deps: {
    git: GitPort;
    verifyCommitPushed: (input: {
      cwd: string;
      branch: string;
      startCommitSha: string;
      commitSha?: string;
    }) => Promise<boolean>;
  },
  context: { cwd: string; branch: string; startCommitSha: string | undefined },
  commitSha: string | undefined,
): Promise<RemoteFixCommitVerification> {
  if (!commitSha) {
    return {
      commitVerified: false,
      fixCommitOnRemote: false,
      isNewerThanStart: false,
      reason: 'commit not pushed to remote',
    };
  }

  const commitVerified = context.startCommitSha
    ? await deps.verifyCommitPushed({
        cwd: context.cwd,
        branch: context.branch,
        startCommitSha: context.startCommitSha,
        commitSha,
      })
    : true;

  const remoteSha = await deps.git.remoteRef({
    cwd: context.cwd,
    remote: 'origin',
    ref: context.branch,
  });
  const fixCommitOnRemote = remoteSha
    ? await deps.git.isAncestor(context.cwd, commitSha, remoteSha)
    : false;
  const isNewerThanStart = context.startCommitSha
    ? (await deps.git.logBetween(context.cwd, context.startCommitSha, commitSha)).length > 0
    : true;

  let reason = '';
  if (!fixCommitOnRemote) reason = 'fix commit is not an ancestor of remote branch tip';
  else if (!isNewerThanStart) reason = 'fix commit is not newer than start (logBetween empty)';
  else if (!commitVerified) reason = 'commit not pushed to remote';

  return { commitVerified, fixCommitOnRemote, isNewerThanStart, reason };
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
    fixDiffInspector?: FixDiffInspectorPort;
  },
  context: {
    cwd: string;
    branch: string;
    prNumber: number;
    repoFullName: string;
    originalStartCommitSha: string | undefined;
    runningStartSha: string | undefined;
    repoId?: string;
  },
): Promise<VerificationResult> {
  const replyVerified = await verifyReplyPosted(deps, context, comment.commentId);

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

  const commitShaChanged =
    comment.commitSha !== undefined && comment.commitSha !== context.runningStartSha;
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

  const buildResult = await deps.verifyBuildPasses({
    cwd: context.cwd,
    runId: String(comment.runId),
  });
  const buildVerified = buildResult.passed;
  const buildError = buildResult.error;

  const remote = await verifyRemoteFixCommit(
    deps,
    { cwd: context.cwd, branch: context.branch, startCommitSha: context.runningStartSha },
    comment.commitSha,
  );

  let failReason = '';
  if (!replyVerified) failReason = 'reply not found on GitHub';
  else if (!remote.fixCommitOnRemote)
    failReason = 'fix commit is not an ancestor of remote branch tip';
  else if (!remote.isNewerThanStart)
    failReason = 'fix commit is not newer than start (logBetween empty)';
  else if (!remote.commitVerified) failReason = 'commit not pushed to remote';
  else if (!buildVerified) failReason = 'build did not pass';

  // Semantic code verification — only when all mechanical checks pass
  let codeVerified = true;
  let codeVerifyReason: string | undefined;

  const mechanicalOk =
    remote.fixCommitOnRemote &&
    remote.isNewerThanStart &&
    remote.commitVerified &&
    replyVerified &&
    buildVerified;

  if (mechanicalOk && deps.fixDiffInspector && comment.commitSha && context.originalStartCommitSha) {
    const inspection = await deps.fixDiffInspector({
      cwd: context.cwd,
      originalStartCommitSha: context.originalStartCommitSha ?? '',
      runningStartSha: context.runningStartSha ?? '',
      fixCommitSha: comment.commitSha,
      path: comment.path,
      line: comment.line,
    });
    if (!inspection.touchesPath) {
      return {
        ok: false,
        replyVerified,
        commitVerified: remote.commitVerified,
        buildVerified,
        codeVerified: false,
        reason: `fix commit does not touch ${comment.path}`,
        ...(buildError !== undefined ? { buildError } : {}),
        ...(inspection.reason ? { codeVerifyReason: inspection.reason } : {}),
      };
    }
    if (inspection.nearLine === false) {
      return {
        ok: false,
        replyVerified,
        commitVerified: remote.commitVerified,
        buildVerified,
        codeVerified: false,
        reason: `code verification failed: ${inspection.reason}`,
        ...(inspection.reason ? { codeVerifyReason: inspection.reason } : {}),
        ...(buildError !== undefined ? { buildError } : {}),
      };
    }
    // nearLine === true | 'skipped' → continue to verifyCodeChange.
  }

  if (mechanicalOk && deps.verifyCodeChange && comment.commitSha) {
    const codeResult = await deps.verifyCodeChange({
      commentBody: comment.body,
      path: comment.path,
      line: comment.line,
      cwd: context.cwd,
      startCommitSha: context.runningStartSha ?? '',
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
    commitVerified: remote.commitVerified,
    buildVerified,
    codeVerified,
    reason: ok ? '' : failReason,
    ...(buildError !== undefined ? { buildError } : {}),
    ...(codeVerifyReason !== undefined ? { codeVerifyReason } : {}),
  };
}
