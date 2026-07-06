import { describe, it, expect } from 'vitest';
import { RunId, createPrReviewComment } from '@ai-sdlc/domain';
import {
  FakeGitHubPort,
  FakeGitPort,
  FakeFixDiffInspector,
  makeFixDiffInspector,
} from '../../test-doubles/index.js';
import type { VerifyCodeChangeFn } from '../verify-code-change.js';
import { verifyComment } from '../verify-comment.js';

const runId = RunId('44444444-4444-4444-4444-444444444444');

function makeContext() {
  return {
    cwd: '/work/tree',
    branch: 'feat-x',
    prNumber: 5,
    repoFullName: 'o/r',
    originalStartCommitSha: 'startSha',
    runningStartSha: 'startSha',
  };
}

function makeReplied(overrides: Partial<{ path: string; line: number }> = {}) {
  return {
    ...createPrReviewComment({
      runId,
      prNumber: 5,
      commentId: 9001,
      path: overrides.path ?? 'a.ts',
      line: overrides.line ?? 3,
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
}

function setupMechanicalOk(github: FakeGitHubPort, git: FakeGitPort) {
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
}

describe('verifyComment — structural pre-check', () => {
  it('falls through to the verifyCodeChange LLM pass when the inspector returns touchesPath:false (#629 cross-file fixes)', async () => {
    const github = new FakeGitHubPort();
    const git = new FakeGitPort();
    setupMechanicalOk(github, git);
    const inspector = new FakeFixDiffInspector();
    inspector.setNext({
      touchesPath: false,
      nearLine: 'skipped',
      reason: 'fix commit abcdef0 does not touch a.ts',
    });
    const verifyCodeChangeCalls: unknown[] = [];
    const verifyCodeChangeSpy: VerifyCodeChangeFn = (async (input: unknown) => {
      verifyCodeChangeCalls.push(input);
      return { pass: true, reason: 'fix addresses the comment via another file' };
    }) as VerifyCodeChangeFn;
    const result = await verifyComment(
      makeReplied(),
      {
        git,
        github,
        verifyCommitPushed: async () => true,
        verifyBuildPasses: async () => ({ passed: true }),
        verifyCodeChange: verifyCodeChangeSpy,
        fixDiffInspector: makeFixDiffInspector(inspector),
      },
      makeContext(),
    );
    expect(verifyCodeChangeCalls).toHaveLength(1);
    expect(result.ok).toBe(true);
    expect(result.codeVerified).toBe(true);
  });

  it('keeps rejecting touchesPath:false when no semantic verifier is wired (Codex P2 on #630)', async () => {
    const github = new FakeGitHubPort();
    const git = new FakeGitPort();
    setupMechanicalOk(github, git);
    const inspector = new FakeFixDiffInspector();
    inspector.setNext({
      touchesPath: false,
      nearLine: 'skipped',
      reason: 'fix commit abcdef0 does not touch a.ts',
    });
    const result = await verifyComment(
      makeReplied(),
      {
        git,
        github,
        verifyCommitPushed: async () => true,
        verifyBuildPasses: async () => ({ passed: true }),
        // no verifyCodeChange: nothing can evaluate a cross-file diff
        fixDiffInspector: makeFixDiffInspector(inspector),
      },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    expect(result.codeVerified).toBe(false);
    expect(result.reason).toContain('does not touch a.ts');
    expect(result.codeVerifyReason).toContain('does not touch a.ts');
  });

  it('still fails via the LLM pass when a cross-file fix does not actually address the comment', async () => {
    const github = new FakeGitHubPort();
    const git = new FakeGitPort();
    setupMechanicalOk(github, git);
    const inspector = new FakeFixDiffInspector();
    inspector.setNext({
      touchesPath: false,
      nearLine: 'skipped',
      reason: 'fix commit abcdef0 does not touch a.ts',
    });
    const verifyCodeChangeSpy: VerifyCodeChangeFn = (async () => {
      return { pass: false, reason: 'changes elsewhere do not address the comment' };
    }) as VerifyCodeChangeFn;
    const result = await verifyComment(
      makeReplied(),
      {
        git,
        github,
        verifyCommitPushed: async () => true,
        verifyBuildPasses: async () => ({ passed: true }),
        verifyCodeChange: verifyCodeChangeSpy,
        fixDiffInspector: makeFixDiffInspector(inspector),
      },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    expect(result.codeVerified).toBe(false);
    expect(result.codeVerifyReason).toContain('do not address the comment');
  });

  it('returns ok:true and skips LLM when structural pre-check returns touchesPath:true + nearLine:true', async () => {
    const github = new FakeGitHubPort();
    const git = new FakeGitPort();
    setupMechanicalOk(github, git);
    const inspector = new FakeFixDiffInspector();
    inspector.setNext({ touchesPath: true, nearLine: true, reason: '' });
    const verifyCodeChangeCalls: unknown[] = [];
    const verifyCodeChange: VerifyCodeChangeFn = async (input) => {
      verifyCodeChangeCalls.push(input);
      return { pass: true, reason: 'LLM passed' };
    };
    const result = await verifyComment(
      makeReplied(),
      {
        git,
        github,
        verifyCommitPushed: async () => true,
        verifyBuildPasses: async () => ({ passed: true }),
        verifyCodeChange,
        fixDiffInspector: makeFixDiffInspector(inspector),
      },
      makeContext(),
    );
    // When structural pre-check passes AND verifyCodeChange is provided, LLM is still authoritative.
    expect(result.ok).toBe(true);
    expect(result.codeVerified).toBe(true);
    expect(verifyCodeChangeCalls).toHaveLength(1);
  });

  it('returns ok:false + nearLine:false structural outcome is short-circuited to a block reason', async () => {
    const github = new FakeGitHubPort();
    const git = new FakeGitPort();
    setupMechanicalOk(github, git);
    const inspector = new FakeFixDiffInspector();
    inspector.setNext({
      touchesPath: true,
      nearLine: false,
      reason: 'fix touches a.ts but no changed line within \xb15 of comment line 3',
    });
    const verifyCodeChange: VerifyCodeChangeFn = async () => {
      throw new Error('verifyCodeChange must not run when structural said nearLine:false');
    };
    const result = await verifyComment(
      makeReplied(),
      {
        git,
        github,
        verifyCommitPushed: async () => true,
        verifyBuildPasses: async () => ({ passed: true }),
        verifyCodeChange,
        fixDiffInspector: makeFixDiffInspector(inspector),
      },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    expect(result.codeVerified).toBe(false);
    expect(result.codeVerifyReason).toContain('within \xb15');
    expect(result.reason).toContain('code verification failed');
  });

  it('continues to verifyCodeChange LLM when structural nearLine returns skipped', async () => {
    const github = new FakeGitHubPort();
    const git = new FakeGitPort();
    setupMechanicalOk(github, git);
    const inspector = new FakeFixDiffInspector();
    inspector.setNext({
      touchesPath: true,
      nearLine: 'skipped',
      reason: 'accumulated diff on a.ts is ambiguous',
    });
    const verifyCodeChangeCalls: unknown[] = [];
    const verifyCodeChange: VerifyCodeChangeFn = async () => {
      verifyCodeChangeCalls.push({});
      return { pass: true, reason: 'ok' };
    };
    const result = await verifyComment(
      makeReplied(),
      {
        git,
        github,
        verifyCommitPushed: async () => true,
        verifyBuildPasses: async () => ({ passed: true }),
        verifyCodeChange,
        fixDiffInspector: makeFixDiffInspector(inspector),
      },
      makeContext(),
    );
    expect(verifyCodeChangeCalls).toHaveLength(1);
    expect(result.ok).toBe(true);
  });

  it('preserves existing behavior when no fixDiffInspector is provided', async () => {
    const github = new FakeGitHubPort();
    const git = new FakeGitPort();
    setupMechanicalOk(github, git);
    const result = await verifyComment(
      makeReplied(),
      {
        git,
        github,
        verifyCommitPushed: async () => true,
        verifyBuildPasses: async () => ({ passed: true }),
      },
      makeContext(),
    );
    expect(result.ok).toBe(true);
  });
});
