import { describe, it, expect, vi } from 'vitest';
import { RunId, createPrReviewComment } from '@ai-sdlc/domain';
import { FakeGitHubPort, FakeGitPort } from '../../test-doubles/index.js';
import type { GitPort } from '../../ports/git-port.js';
import type { GitHubPort } from '../../ports/github-port.js';
import { verifyComment } from '../verify-comment.js';
import type { VerifyCodeChangeFn } from '../verify-code-change.js';

interface VerifyCommentDeps {
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
}

const runId = RunId('44444444-4444-4444-4444-444444444444');

function makeContext(
  overrides: Partial<{
    cwd: string;
    branch: string;
    prNumber: number;
    repoFullName: string;
    startCommitSha: string;
  }> = {},
) {
  return {
    cwd: '/work/tree',
    branch: 'feat-x',
    prNumber: 5,
    repoFullName: 'o/r',
    startCommitSha: 'startSha',
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<{
    verifyCommitPushed: VerifyCommentDeps['verifyCommitPushed'];
    verifyBuildPasses: VerifyCommentDeps['verifyBuildPasses'];
  }> = {},
): {
  deps: VerifyCommentDeps;
  github: FakeGitHubPort;
  git: FakeGitPort;
} {
  const github = new FakeGitHubPort();
  const git = new FakeGitPort();
  const deps = {
    git,
    github,
    verifyCommitPushed: async () => true,
    verifyBuildPasses: async () => ({ passed: true }),
    ...overrides,
  };
  return { deps, github, git };
}

describe('verifyComment — fixed outcome', () => {
  it('returns ok=true when all checks pass for a fixed comment', async () => {
    const { deps, github, git } = makeDeps();
    const ctx = makeContext({ startCommitSha: 'startSha' });
    const comment = {
      ...createPrReviewComment({
        runId,
        prNumber: 5,
        commentId: 9001,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix please',
        now: new Date(),
      }),
      state: 'replied' as const,
      outcome: 'fixed' as const,
      commitSha: 'fixSha',
      replyId: 9002,
      attempts: 1,
    };

    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix please',
        createdAt: new Date(),
      },
      {
        id: 9002,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'agent',
        body: 'Fixed.',
        createdAt: new Date(),
        inReplyToId: 9001,
      },
    ]);
    git.remoteRefs.set('origin/feat-x', 'tipSha');
    git.ancestorResults.set('fixSha|tipSha', true);
    git.logBetweenResults.set('startSha|fixSha', ['fixSha']);

    const result = await verifyComment(comment, deps, ctx);
    expect(result.ok).toBe(true);
    expect(result.replyVerified).toBe(true);
    expect(result.commitVerified).toBe(true);
    expect(result.buildVerified).toBe(true);
  });

  it('returns ok=false when commitSha matches startCommitSha (no new commit)', async () => {
    const { deps, github, git } = makeDeps();
    const ctx = makeContext({ startCommitSha: 'startSha' });
    const comment = {
      ...createPrReviewComment({
        runId,
        prNumber: 5,
        commentId: 9001,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix please',
        now: new Date(),
      }),
      state: 'replied' as const,
      outcome: 'fixed' as const,
      commitSha: 'startSha',
      replyId: 9002,
      attempts: 1,
    };

    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix please',
        createdAt: new Date(),
      },
      {
        id: 9002,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'agent',
        body: 'Fixed.',
        createdAt: new Date(),
        inReplyToId: 9001,
      },
    ]);
    git.remoteRefs.set('origin/feat-x', 'tipSha');
    git.ancestorResults.set('startSha|tipSha', true);
    git.logBetweenResults.set('startSha|startSha', []);

    const result = await verifyComment(comment, deps, ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('commit');
  });

  it('returns ok=false when fix commit is not an ancestor of the remote branch tip', async () => {
    const { deps, github, git } = makeDeps();
    const ctx = makeContext({ startCommitSha: 'startSha' });
    const comment = {
      ...createPrReviewComment({
        runId,
        prNumber: 5,
        commentId: 9001,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix please',
        now: new Date(),
      }),
      state: 'replied' as const,
      outcome: 'fixed' as const,
      commitSha: 'fixSha',
      replyId: 9002,
      attempts: 1,
    };

    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix please',
        createdAt: new Date(),
      },
      {
        id: 9002,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'agent',
        body: 'Fixed.',
        createdAt: new Date(),
        inReplyToId: 9001,
      },
    ]);
    git.remoteRefs.set('origin/feat-x', 'tipSha');
    git.ancestorResults.set('fixSha|tipSha', false);

    const result = await verifyComment(comment, deps, ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('ancestor');
  });

  it('returns ok=false when reply is missing on GitHub', async () => {
    const { deps, github, git } = makeDeps();
    const ctx = makeContext({ startCommitSha: 'startSha' });
    const comment = {
      ...createPrReviewComment({
        runId,
        prNumber: 5,
        commentId: 9001,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix please',
        now: new Date(),
      }),
      state: 'replied' as const,
      outcome: 'fixed' as const,
      commitSha: 'fixSha',
      attempts: 1,
    };

    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix please',
        createdAt: new Date(),
      },
    ]);
    git.remoteRefs.set('origin/feat-x', 'fixSha');
    git.ancestorResults.set('fixSha|fixSha', true);
    git.logBetweenResults.set('startSha|fixSha', ['fixSha']);

    const result = await verifyComment(comment, deps, ctx);
    expect(result.ok).toBe(false);
    expect(result.replyVerified).toBe(false);
    expect(result.reason).toContain('reply');
  });

  it('returns ok=false when verifyCommitPushed returns false', async () => {
    const { deps, github, git } = makeDeps({
      verifyCommitPushed: async () => false,
    });
    const ctx = makeContext({ startCommitSha: 'startSha' });
    const comment = {
      ...createPrReviewComment({
        runId,
        prNumber: 5,
        commentId: 9001,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix please',
        now: new Date(),
      }),
      state: 'replied' as const,
      outcome: 'fixed' as const,
      commitSha: 'fixSha',
      replyId: 9002,
      attempts: 1,
    };

    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix please',
        createdAt: new Date(),
      },
      {
        id: 9002,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'agent',
        body: 'Fixed.',
        createdAt: new Date(),
        inReplyToId: 9001,
      },
    ]);
    git.remoteRefs.set('origin/feat-x', 'tipSha');
    git.ancestorResults.set('fixSha|tipSha', true);
    git.logBetweenResults.set('startSha|fixSha', ['fixSha']);

    const result = await verifyComment(comment, deps, ctx);
    expect(result.ok).toBe(false);
    expect(result.commitVerified).toBe(false);
    expect(result.reason).toContain('push');
  });

  it('returns ok=false when verifyBuildPasses returns false', async () => {
    const { deps, github, git } = makeDeps({
      verifyBuildPasses: async () => ({ passed: false }),
    });
    const ctx = makeContext({ startCommitSha: 'startSha' });
    const comment = {
      ...createPrReviewComment({
        runId,
        prNumber: 5,
        commentId: 9001,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix please',
        now: new Date(),
      }),
      state: 'replied' as const,
      outcome: 'fixed' as const,
      commitSha: 'fixSha',
      replyId: 9002,
      attempts: 1,
    };

    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix please',
        createdAt: new Date(),
      },
      {
        id: 9002,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'agent',
        body: 'Fixed.',
        createdAt: new Date(),
        inReplyToId: 9001,
      },
    ]);
    git.remoteRefs.set('origin/feat-x', 'tipSha');
    git.ancestorResults.set('fixSha|tipSha', true);
    git.logBetweenResults.set('startSha|fixSha', ['fixSha']);

    const result = await verifyComment(comment, deps, ctx);
    expect(result.ok).toBe(false);
    expect(result.buildVerified).toBe(false);
    expect(result.reason).toContain('build');
  });

  it('returns ok=false when logBetween returns empty (commit not newer than start)', async () => {
    const { deps, github, git } = makeDeps();
    const ctx = makeContext({ startCommitSha: 'startSha' });
    const comment = {
      ...createPrReviewComment({
        runId,
        prNumber: 5,
        commentId: 9001,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix please',
        now: new Date(),
      }),
      state: 'replied' as const,
      outcome: 'fixed' as const,
      commitSha: 'fixSha',
      replyId: 9002,
      attempts: 1,
    };

    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix please',
        createdAt: new Date(),
      },
      {
        id: 9002,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'agent',
        body: 'Fixed.',
        createdAt: new Date(),
        inReplyToId: 9001,
      },
    ]);
    git.remoteRefs.set('origin/feat-x', 'tipSha');
    git.ancestorResults.set('fixSha|tipSha', true);
    git.logBetweenResults.set('startSha|fixSha', []);

    const result = await verifyComment(comment, deps, ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('log');
  });

  it('returns ok=false and reason when remote ref is missing', async () => {
    const { deps, github } = makeDeps();
    const ctx = makeContext({ startCommitSha: 'startSha' });
    const comment = {
      ...createPrReviewComment({
        runId,
        prNumber: 5,
        commentId: 9001,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix please',
        now: new Date(),
      }),
      state: 'replied' as const,
      outcome: 'fixed' as const,
      commitSha: 'fixSha',
      replyId: 9002,
      attempts: 1,
    };

    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix please',
        createdAt: new Date(),
      },
      {
        id: 9002,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'agent',
        body: 'Fixed.',
        createdAt: new Date(),
        inReplyToId: 9001,
      },
    ]);

    const result = await verifyComment(comment, deps, ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('remote');
  });

  it('returns buildError when verifyBuildPasses returns an error', async () => {
    const { deps, github, git } = makeDeps({
      verifyBuildPasses: async () => ({ passed: false, error: 'typecheck failed: TS2322' }),
    });
    git.headByCwd.set('/work/tree', 'startSha');
    git.remoteRefs.set('origin/feat-x', 'fixSha');
    git.ancestorResults.set('fixSha|fixSha', true);
    git.logBetweenResults.set('startSha|fixSha', ['fixSha']);
    const ctx = makeContext({ startCommitSha: 'startSha' });
    const comment = {
      ...createPrReviewComment({
        runId,
        prNumber: 5,
        commentId: 9001,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix please',
        now: new Date(),
      }),
      state: 'replied' as const,
      outcome: 'fixed' as const,
      commitSha: 'fixSha',
      replyId: 9002,
      attempts: 1,
    };

    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix please',
        createdAt: new Date(),
      },
      {
        id: 9002,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'agent',
        body: 'fixed',
        createdAt: new Date(),
      },
    ]);

    const result = await verifyComment(comment, deps, ctx);
    expect(result.ok).toBe(false);
    expect(result.buildVerified).toBe(false);
    expect(result.buildError).toBe('typecheck failed: TS2322');
  });
});

describe('verifyComment — no_fix outcome', () => {
  it('returns ok=true when reply is verified', async () => {
    const { deps, github } = makeDeps();
    const ctx = makeContext();
    const comment = {
      ...createPrReviewComment({
        runId,
        prNumber: 5,
        commentId: 9001,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix please',
        now: new Date(),
      }),
      state: 'replied' as const,
      outcome: 'no_fix' as const,
      replyId: 9002,
      attempts: 1,
    };

    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix please',
        createdAt: new Date(),
      },
      {
        id: 9002,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'agent',
        body: 'Not a bug.',
        createdAt: new Date(),
        inReplyToId: 9001,
      },
    ]);

    const result = await verifyComment(comment, deps, ctx);
    expect(result.ok).toBe(true);
    expect(result.replyVerified).toBe(true);
  });

  it('returns ok=false when reply is missing', async () => {
    const { deps, github } = makeDeps();
    const ctx = makeContext();
    const comment = {
      ...createPrReviewComment({
        runId,
        prNumber: 5,
        commentId: 9001,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix please',
        now: new Date(),
      }),
      state: 'replied' as const,
      outcome: 'no_fix' as const,
      attempts: 1,
    };

    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix please',
        createdAt: new Date(),
      },
    ]);

    const result = await verifyComment(comment, deps, ctx);
    expect(result.ok).toBe(false);
    expect(result.replyVerified).toBe(false);
  });
});

// (Add these tests at the end of the file, after existing describe blocks)

describe('verifyComment — codeVerified check', () => {
  it('sets codeVerified:true when verifyCodeChange returns pass:true', async () => {
    const { deps, github, git } = makeDeps();
    const verifyCodeChange: VerifyCodeChangeFn = async () => ({ pass: true, reason: 'ok' });
    const ctx = makeContext({ startCommitSha: 'startSha' });
    const comment = {
      ...createPrReviewComment({
        runId,
        prNumber: 5,
        commentId: 9001,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix please',
        now: new Date(),
      }),
      state: 'replied' as const,
      outcome: 'fixed' as const,
      commitSha: 'fixSha',
      replyId: 9002,
      attempts: 1,
    };

    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix please',
        createdAt: new Date(),
      },
      {
        id: 9002,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'agent',
        body: 'Fixed.',
        createdAt: new Date(),
        inReplyToId: 9001,
      },
    ]);
    git.remoteRefs.set('origin/feat-x', 'tipSha');
    git.ancestorResults.set('fixSha|tipSha', true);
    git.logBetweenResults.set('startSha|fixSha', ['fixSha']);

    const result = await verifyComment(comment, { ...deps, verifyCodeChange }, ctx);
    expect(result.ok).toBe(true);
    expect(result.codeVerified).toBe(true);
  });

  it('sets ok:false and codeVerified:false when verifyCodeChange returns pass:false', async () => {
    const { deps, github, git } = makeDeps();
    const verifyCodeChange: VerifyCodeChangeFn = async () => ({
      pass: false,
      reason: 'variable still mutable',
    });
    const ctx = makeContext({ startCommitSha: 'startSha' });
    const comment = {
      ...createPrReviewComment({
        runId,
        prNumber: 5,
        commentId: 9001,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix please',
        now: new Date(),
      }),
      state: 'replied' as const,
      outcome: 'fixed' as const,
      commitSha: 'fixSha',
      replyId: 9002,
      attempts: 1,
    };

    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix please',
        createdAt: new Date(),
      },
      {
        id: 9002,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'agent',
        body: 'Fixed.',
        createdAt: new Date(),
        inReplyToId: 9001,
      },
    ]);
    git.remoteRefs.set('origin/feat-x', 'tipSha');
    git.ancestorResults.set('fixSha|tipSha', true);
    git.logBetweenResults.set('startSha|fixSha', ['fixSha']);

    const result = await verifyComment(comment, { ...deps, verifyCodeChange }, ctx);
    expect(result.ok).toBe(false);
    expect(result.codeVerified).toBe(false);
    expect(result.codeVerifyReason).toBe('variable still mutable');
    expect(result.reason).toContain('code verification failed');
  });

  it('skips codeVerified check for no_fix outcome', async () => {
    const { deps, github } = makeDeps();
    const verifyCodeChange: VerifyCodeChangeFn = vi.fn(async () => ({
      pass: false,
      reason: 'nope',
    }));
    const ctx = makeContext();
    const comment = {
      ...createPrReviewComment({
        runId,
        prNumber: 5,
        commentId: 9001,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix please',
        now: new Date(),
      }),
      state: 'replied' as const,
      outcome: 'no_fix' as const,
      replyId: 9002,
      attempts: 1,
    };

    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix please',
        createdAt: new Date(),
      },
      {
        id: 9002,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'agent',
        body: 'Not a bug.',
        createdAt: new Date(),
        inReplyToId: 9001,
      },
    ]);

    const result = await verifyComment(comment, { ...deps, verifyCodeChange }, ctx);
    expect(result.ok).toBe(true);
    expect(result.codeVerified).toBe(true);
    expect(verifyCodeChange).not.toHaveBeenCalled();
  });

  it('defaults codeVerified:true when verifyCodeChange dep is absent', async () => {
    const { deps, github, git } = makeDeps(); // no verifyCodeChange
    const ctx = makeContext({ startCommitSha: 'startSha' });
    const comment = {
      ...createPrReviewComment({
        runId,
        prNumber: 5,
        commentId: 9001,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix please',
        now: new Date(),
      }),
      state: 'replied' as const,
      outcome: 'fixed' as const,
      commitSha: 'fixSha',
      replyId: 9002,
      attempts: 1,
    };

    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix please',
        createdAt: new Date(),
      },
      {
        id: 9002,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'agent',
        body: 'Fixed.',
        createdAt: new Date(),
        inReplyToId: 9001,
      },
    ]);
    git.remoteRefs.set('origin/feat-x', 'tipSha');
    git.ancestorResults.set('fixSha|tipSha', true);
    git.logBetweenResults.set('startSha|fixSha', ['fixSha']);

    const result = await verifyComment(comment, deps, ctx);
    expect(result.ok).toBe(true);
    expect(result.codeVerified).toBe(true);
  });
});
