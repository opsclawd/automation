import { describe, it, expect } from 'vitest';
import { RunId, RepositoryId, PhaseName, createPrReviewComment } from '@ai-sdlc/domain';
import {
  FakeGitHubPort,
  FakeGitPort,
  FakePrReviewRepository,
  FakeAgentPort,
} from '../../test-doubles/index.js';
import type { AgentInvocationResult } from '../../ports/agent-invocation-types.js';
import {
  ProcessPrReviewComments,
  type ProcessPrReviewDeps,
} from '../process-pr-review-comments.js';

const runId = RunId('44444444-4444-4444-4444-444444444444');
const repoId = RepositoryId('o/r');

function makeSuccessAgentResult(
  overrides: Partial<AgentInvocationResult> = {},
): AgentInvocationResult {
  return {
    runtime: 'opencode',
    provider: 'test',
    model: 'test',
    exitCode: 0,
    durationMs: 100,
    stdoutPath: '/dev/null',
    stderrPath: '/dev/null',
    resultJsonPath: '/tmp/result.json',
    contractViolations: [],
    outcome: 'success',
    ...overrides,
  };
}

class TwoShaGitPort extends FakeGitPort {
  private callCount = 0;
  constructor(
    private firstSha: string,
    private secondSha: string,
  ) {
    super();
  }
  override async headCommitSha(_cwd: string): Promise<string> {
    this.callCount++;
    return this.callCount <= 1 ? this.firstSha : this.secondSha;
  }
}

function makeDeps(overrides: Partial<ProcessPrReviewDeps> = {}): {
  deps: ProcessPrReviewDeps;
  github: FakeGitHubPort;
  git: FakeGitPort;
  repo: FakePrReviewRepository;
  agent: FakeAgentPort;
} {
  const github = new FakeGitHubPort();
  const git = new TwoShaGitPort('abc123', 'def456');
  const repo = new FakePrReviewRepository();
  const agent = new FakeAgentPort({
    'post-pr-review-profile': [makeSuccessAgentResult()],
  });

  github.prs.set('o/r/5', {
    number: 5,
    url: 'https://x/pr/5',
    state: 'open',
    headRefName: 'feat-x',
  });
  github.comments.set('o/r/5', [
    {
      id: 9001,
      prNumber: 5,
      path: 'a.ts',
      line: 3,
      reviewer: 'octocat',
      body: 'rename foo',
      createdAt: new Date('2026-06-04T00:00:00Z'),
    },
  ]);
  git.remoteRefs.set('origin/feat-x', 'abc123');

  let replyCounter = 0;
  const deps: ProcessPrReviewDeps = {
    github,
    git,
    agent,
    prReviewRepo: repo,
    renderPrompt: async () => '/tmp/prompt.md',
    extractResult: async () => ({
      ok: true,
      result: {
        outcome: 'ALL_DONE',
        comments: [{ commentId: 9001, action: 'fixed', replyBody: 'Renamed foo to bar.' }],
      },
    }),
    verifyCommitPushed: async () => true,
    verifyBuildPasses: async () => true,
    resolveProfileForPhase: () => 'post-pr-review-profile' as never,
    idFactory: () => `id-${++replyCounter}`,
    now: () => new Date('2026-06-04T00:10:00Z'),
    maxIterations: 10,
    ...overrides,
  };
  return { deps, github, git, repo, agent };
}

describe('ProcessPrReviewComments — happy path', () => {
  it('fixes, replies, verifies, resolves, and marks the comment processed', async () => {
    const { deps, github, repo } = makeDeps();
    const uc = new ProcessPrReviewComments(deps);

    const out = await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 1,
    });

    expect(out.outcome).toBe('ALL_DONE');
    expect(out.processed).toBe(1);
    expect(out.blocked).toBe(0);
    expect(out.allResolved).toBe(true);

    expect(github.repliesPosted).toContainEqual({
      repoFullName: 'o/r',
      prNumber: 5,
      commentId: 9001,
      body: 'Renamed foo to bar.',
    });
    expect(github.resolvedThreads).toContainEqual({
      repoFullName: 'o/r',
      prNumber: 5,
      commentId: 9001,
    });
    const comment = repo.getComment(runId, 9001);
    expect(comment?.state).toBe('processed');
    expect(comment?.commitVerified).toBe(true);
    expect(comment?.replyVerified).toBe(true);
    expect(comment?.buildVerified).toBe(true);

    const poll = repo.latestPollAttempt(runId);
    expect(poll?.terminalState).toBe('all_resolved');
  });
});

describe('ProcessPrReviewComments — dedup', () => {
  it('does not invoke the agent when the only comment is already processed', async () => {
    const { deps, repo, agent } = makeDeps();
    const seeded = createPrReviewComment({
      runId,
      prNumber: 5,
      commentId: 9001,
      path: 'a.ts',
      line: 3,
      reviewer: 'octocat',
      body: 'rename foo',
      now: new Date(),
    });
    repo.upsertComment({
      ...seeded,
      state: 'processed',
      commitVerified: true,
      replyVerified: true,
      buildVerified: true,
    });

    const uc = new ProcessPrReviewComments(deps);
    const out = await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 2,
    });

    expect(out.outcome).toBe('NO_UNRESOLVED');
    expect(agent.invocations.length).toBe(0);
    expect(repo.latestPollAttempt(runId)?.terminalState).toBe('all_resolved');
  });

  it('skips already-processed comments in the apply loop', async () => {
    const { deps, repo, github } = makeDeps();
    const seeded = createPrReviewComment({
      runId,
      prNumber: 5,
      commentId: 9001,
      path: 'a.ts',
      line: 3,
      reviewer: 'octocat',
      body: 'rename foo',
      now: new Date(),
    });
    repo.upsertComment({
      ...seeded,
      state: 'processed',
      commitVerified: true,
      replyVerified: true,
      buildVerified: true,
    });

    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'rename foo',
        createdAt: new Date(),
      },
      {
        id: 9002,
        prNumber: 5,
        path: 'b.ts',
        line: 10,
        reviewer: 'reviewer2',
        body: 'fix typo',
        createdAt: new Date(),
      },
    ]);

    const uc = new ProcessPrReviewComments(deps);
    await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 1,
    });

    expect(github.repliesPosted.filter((r) => r.commentId === 9001)).toHaveLength(0);
    expect(repo.getComment(runId, 9001)?.state).toBe('processed');
  });
});

describe('ProcessPrReviewComments — blocking', () => {
  it('blocks a comment when verification fails (build failed)', async () => {
    const agent = new FakeAgentPort({
      'post-pr-review-profile': [
        makeSuccessAgentResult(),
        makeSuccessAgentResult(),
        makeSuccessAgentResult(),
      ],
    });
    const { deps, repo, github } = makeDeps({
      agent,
      verifyBuildPasses: async () => false,
      extractResult: async () => ({
        ok: true,
        result: {
          outcome: 'PARTIAL',
          comments: [{ commentId: 9001, action: 'fixed', replyBody: 'attempted fix' }],
        },
      }),
    });
    const uc = new ProcessPrReviewComments(deps);
    const out = await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 1,
    });
    const after1 = repo.getComment(runId, 9001);
    expect(after1?.state).toBe('blocked');
    expect(out.blocked).toBe(1);
    expect(github.repliesPosted).toHaveLength(1);
  });
});

describe('ProcessPrReviewComments — invalid result', () => {
  it('records a failed poll and posts no replies when extractResult fails', async () => {
    const { deps, github, repo } = makeDeps({
      extractResult: async () => ({
        ok: false,
        reason: 'invalid_result',
        detail: 'result.json missing outcome field',
      }),
    });
    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix this',
        createdAt: new Date('2026-06-04T00:00:00Z'),
      },
    ]);
    const uc = new ProcessPrReviewComments(deps);
    const out = await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 1,
    });
    expect(out.outcome).toBe('BLOCKED');
    expect(github.repliesPosted).toHaveLength(0);
    const poll = repo.latestPollAttempt(runId);
    expect(poll?.status).toBe('failed');
  });
});

describe('ProcessPrReviewComments — no_fix action', () => {
  it('marks a no_fix comment processed without commit/build verification', async () => {
    const { deps, github, repo } = makeDeps({
      extractResult: async () => ({
        ok: true,
        result: {
          outcome: 'NO_FIXES_NEEDED',
          comments: [
            { commentId: 9001, action: 'no_fix', replyBody: 'Intentional design choice.' },
          ],
        },
      }),
    });
    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'why not X?',
        createdAt: new Date('2026-06-04T00:00:00Z'),
      },
    ]);
    const uc = new ProcessPrReviewComments(deps);
    const out = await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 1,
    });
    expect(out.outcome).toBe('NO_FIXES_NEEDED');
    expect(out.processed).toBe(1);
    const comment = repo.getComment(runId, 9001);
    expect(comment?.state).toBe('processed');
    expect(comment?.replyVerified).toBe(true);
    expect(github.resolvedThreads).toContainEqual({
      repoFullName: 'o/r',
      prNumber: 5,
      commentId: 9001,
    });
  });
});

describe('ProcessPrReviewComments — multiple comments', () => {
  it('processes a mix of fixed and no_fix comments in one pass', async () => {
    const { deps, github, repo } = makeDeps({
      extractResult: async () => ({
        ok: true,
        result: {
          outcome: 'PARTIAL',
          comments: [
            { commentId: 9001, action: 'fixed', replyBody: 'Fixed the typo.' },
            { commentId: 9002, action: 'no_fix', replyBody: 'Intentional.' },
            {
              commentId: 9003,
              action: 'blocked',
              replyBody: 'Cannot fix safely.',
              blockedReason: 'unsafe change',
            },
          ],
        },
      }),
    });
    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 1,
        reviewer: 'r1',
        body: 'typo',
        createdAt: new Date(),
      },
      {
        id: 9002,
        prNumber: 5,
        path: 'b.ts',
        line: 2,
        reviewer: 'r2',
        body: 'why?',
        createdAt: new Date(),
      },
      {
        id: 9003,
        prNumber: 5,
        path: 'c.ts',
        line: 3,
        reviewer: 'r3',
        body: 'redo',
        createdAt: new Date(),
      },
    ]);
    const uc = new ProcessPrReviewComments(deps);
    const out = await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 1,
    });

    expect(out.outcome).toBe('PARTIAL');
    expect(out.processed).toBe(2);
    expect(out.blocked).toBe(1);
    expect(repo.getComment(runId, 9001)?.state).toBe('processed');
    expect(repo.getComment(runId, 9002)?.state).toBe('processed');
    expect(repo.getComment(runId, 9003)?.state).toBe('blocked');
  });
});

describe('ProcessPrReviewComments — failed agent invocation', () => {
  it('cleans up the worktree when the agent invocation fails', async () => {
    const agent = new FakeAgentPort({
      'post-pr-review-profile': [makeSuccessAgentResult({ outcome: 'failed' })],
    });
    const git = new FakeGitPort();
    git.headByCwd.set('/work/tree', 'abc123');
    git.remoteRefs.set('origin/feat-x', 'abc123');
    const { deps, github } = makeDeps({ agent, git });
    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix this',
        createdAt: new Date('2026-06-04T00:00:00Z'),
      },
    ]);
    const uc = new ProcessPrReviewComments(deps);
    await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 1,
    });
    expect(git.commits.length).toBe(0);
    expect(git.cleanUntrackedCalls).toContain('/work/tree');
  });

  it('records a failed poll and posts no replies when agent invocation fails', async () => {
    const agent = new FakeAgentPort({
      'post-pr-review-profile': [makeSuccessAgentResult({ outcome: 'failed' })],
    });
    const { deps, github, repo } = makeDeps({ agent });
    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix this',
        createdAt: new Date('2026-06-04T00:00:00Z'),
      },
    ]);
    const uc = new ProcessPrReviewComments(deps);
    const out = await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 1,
    });
    expect(out.outcome).toBe('BLOCKED');
    expect(github.repliesPosted).toHaveLength(0);
    const poll = repo.latestPollAttempt(runId);
    expect(poll?.status).toBe('failed');
  });

  it('blocks when agent invocation times out', async () => {
    const agent = new FakeAgentPort({
      'post-pr-review-profile': [makeSuccessAgentResult({ outcome: 'timeout' })],
    });
    const { deps, github, repo } = makeDeps({ agent });
    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix this',
        createdAt: new Date('2026-06-04T00:00:00Z'),
      },
    ]);
    const uc = new ProcessPrReviewComments(deps);
    const out = await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 1,
    });
    expect(out.outcome).toBe('BLOCKED');
    expect(github.repliesPosted).toHaveLength(0);
    expect(repo.latestPollAttempt(runId)?.status).toBe('failed');
  });

  it('blocks when agent invocation has contract violations', async () => {
    const agent = new FakeAgentPort({
      'post-pr-review-profile': [
        makeSuccessAgentResult({
          outcome: 'contract_violation',
          contractViolations: ['missing result.json'],
        }),
      ],
    });
    const { deps, github, repo } = makeDeps({ agent });
    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix this',
        createdAt: new Date('2026-06-04T00:00:00Z'),
      },
    ]);
    const uc = new ProcessPrReviewComments(deps);
    const out = await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 1,
    });
    expect(out.outcome).toBe('BLOCKED');
    expect(github.repliesPosted).toHaveLength(0);
    expect(repo.latestPollAttempt(runId)?.status).toBe('failed');
  });
});

describe('ProcessPrReviewComments — empty non-blocked manifest', () => {
  it('fails the pass when agent returns empty comments with unresolved comments pending', async () => {
    const { deps, github, repo } = makeDeps({
      extractResult: async () => ({
        ok: true,
        result: { outcome: 'NO_FIXES_NEEDED', comments: [] },
      }),
    });
    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix this',
        createdAt: new Date('2026-06-04T00:00:00Z'),
      },
    ]);
    const uc = new ProcessPrReviewComments(deps);
    const out = await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 1,
    });
    expect(out.outcome).toBe('BLOCKED');
    expect(github.repliesPosted).toHaveLength(0);
    const poll = repo.latestPollAttempt(runId);
    expect(poll?.status).toBe('failed');
  });
});

describe('ProcessPrReviewComments — commit SHA change required for fixed', () => {
  it('blocks a fixed comment when the agent did not produce a new commit', async () => {
    const git = new FakeGitPort();
    git.headByCwd.set('/work/tree', 'abc123');
    git.remoteRefs.set('origin/feat-x', 'xyz789');
    const { deps, github, repo } = makeDeps({ git });
    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'rename foo',
        createdAt: new Date('2026-06-04T00:00:00Z'),
      },
    ]);
    const uc = new ProcessPrReviewComments(deps);
    const out = await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 1,
    });
    expect(out.processed).toBe(0);
    expect(out.blocked).toBe(1);
    const comment = repo.getComment(runId, 9001);
    expect(comment?.state).toBe('blocked');
  });
});

describe('ProcessPrReviewComments — top-level BLOCKED outcome', () => {
  it('blocks all unresolved comments when agent returns BLOCKED with empty comments', async () => {
    const { deps, github, repo } = makeDeps({
      extractResult: async () => ({
        ok: true,
        result: { outcome: 'BLOCKED', comments: [] },
      }),
    });
    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix this',
        createdAt: new Date('2026-06-04T00:00:00Z'),
      },
    ]);
    const uc = new ProcessPrReviewComments(deps);
    const out = await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 1,
    });
    expect(out.outcome).toBe('BLOCKED');
    expect(out.blocked).toBe(1);
    expect(out.processed).toBe(0);
    expect(out.allResolved).toBe(false);
    expect(repo.getComment(runId, 9001)?.state).toBe('blocked');
    expect(github.repliesPosted).toHaveLength(0);
    const poll = repo.latestPollAttempt(runId);
    expect(poll?.terminalState).toBe('blocked');
  });
});

describe('ProcessPrReviewComments — replied with failed verification prevents allResolved', () => {
  it('does not report allResolved when a replied comment has unverified reply', async () => {
    const agent = new FakeAgentPort({
      'post-pr-review-profile': [makeSuccessAgentResult(), makeSuccessAgentResult()],
    });
    const { deps, github, repo } = makeDeps({
      agent,
      verifyBuildPasses: async () => false,
      extractResult: async () => ({
        ok: true,
        result: {
          outcome: 'PARTIAL',
          comments: [{ commentId: 9001, action: 'fixed', replyBody: 'attempted fix' }],
        },
      }),
    });
    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'rename foo',
        createdAt: new Date('2026-06-04T00:00:00Z'),
      },
    ]);
    const uc = new ProcessPrReviewComments(deps);

    const out1 = await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 1,
    });

    expect(out1.allResolved).toBe(false);
    expect(out1.processed).toBe(0);
    expect(out1.blocked).toBe(1);
    const comment = repo.getComment(runId, 9001);
    expect(comment?.state).toBe('blocked');
    expect(comment?.replyVerified).toBe(false);
    const poll = repo.latestPollAttempt(runId);
    expect(poll?.terminalState).toBe('blocked');
  });
});

describe('ProcessPrReviewComments — orphan verification uses remoteRef', () => {
  it('marks an orphaned fixed comment processed when the fix commit is on the remote', async () => {
    const { deps, repo, github, git } = makeDeps();
    git.ancestorResults.set('abc123|abc123', true);
    const seeded = createPrReviewComment({
      runId,
      prNumber: 5,
      commentId: 9001,
      path: 'a.ts',
      line: 3,
      reviewer: 'octocat',
      body: 'rename foo',
      now: new Date('2026-06-04T00:00:00Z'),
    });
    repo.upsertComment({
      ...seeded,
      state: 'replied',
      replyId: 8888,
      outcome: 'fixed',
      commitSha: 'abc123',
      attempts: 1,
      replyVerified: false,
    });

    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'rename foo',
        createdAt: new Date('2026-06-04T00:00:00Z'),
      },
      {
        id: 9002,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'agent',
        body: 'Fixed.',
        createdAt: new Date('2026-06-04T00:05:00Z'),
        inReplyToId: 9001,
      },
    ]);

    const uc = new ProcessPrReviewComments(deps);
    const out = await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 2,
    });

    expect(out.outcome).toBe('NO_UNRESOLVED');
    expect(out.allResolved).toBe(true);
    const comment = repo.getComment(runId, 9001);
    expect(comment?.state).toBe('processed');
    expect(comment?.replyVerified).toBe(true);
  });
});

describe('ProcessPrReviewComments — lenient reply verification', () => {
  it('verifies a reply based on existence (inReplyToId match) even when body differs', async () => {
    const { deps, github, repo } = makeDeps();
    const seeded = createPrReviewComment({
      runId,
      prNumber: 5,
      commentId: 9001,
      path: 'a.ts',
      line: 3,
      reviewer: 'octocat',
      body: 'rename foo',
      now: new Date('2026-06-04T00:00:00Z'),
    });
    repo.upsertComment({
      ...seeded,
      state: 'replied',
      replyId: 8888,
      outcome: 'no_fix',
      attempts: 1,
      replyVerified: false,
    });

    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'rename foo',
        createdAt: new Date('2026-06-04T00:00:00Z'),
      },
      {
        id: 9002,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'agent',
        body: 'Not needed — trailing space gone ',
        createdAt: new Date('2026-06-04T00:05:00Z'),
        inReplyToId: 9001,
      },
    ]);

    const uc = new ProcessPrReviewComments(deps);
    const out = await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 2,
    });

    expect(out.allResolved).toBe(true);
    const comment = repo.getComment(runId, 9001);
    expect(comment?.state).toBe('processed');
    expect(comment?.replyVerified).toBe(true);
  });
});

describe('ProcessPrReviewComments — stale comment IDs', () => {
  it('fails the pass when agent returns non-empty comments but none match pending', async () => {
    const { deps, github, repo } = makeDeps({
      extractResult: async () => ({
        ok: true,
        result: {
          outcome: 'ALL_DONE',
          comments: [{ commentId: 9999, action: 'fixed', replyBody: 'Fixed stale.' }],
        },
      }),
    });
    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'rename foo',
        createdAt: new Date('2026-06-04T00:00:00Z'),
      },
    ]);
    const uc = new ProcessPrReviewComments(deps);
    const out = await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 1,
    });
    expect(out.outcome).toBe('BLOCKED');
    expect(out.processed).toBe(0);
    expect(out.blocked).toBe(0);
    expect(out.allResolved).toBe(false);
    expect(github.repliesPosted).toHaveLength(0);
    const poll = repo.latestPollAttempt(runId);
    expect(poll?.status).toBe('failed');
  });
});

describe('ProcessPrReviewComments — no duplicate replies on failed verification', () => {
  it('keeps a replied comment in replied state when verification fails, preventing duplicate replies', async () => {
    const agent = new FakeAgentPort({
      'post-pr-review-profile': [makeSuccessAgentResult(), makeSuccessAgentResult()],
    });
    const { deps, github, repo } = makeDeps({
      agent,
      verifyBuildPasses: async () => false,
      extractResult: async () => ({
        ok: true,
        result: {
          outcome: 'PARTIAL',
          comments: [{ commentId: 9001, action: 'fixed', replyBody: 'attempted fix' }],
        },
      }),
    });
    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'rename foo',
        createdAt: new Date('2026-06-04T00:00:00Z'),
      },
    ]);
    const uc = new ProcessPrReviewComments(deps);

    await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 1,
    });

    const after1 = repo.getComment(runId, 9001);
    expect(after1?.state).toBe('blocked');
    expect(after1?.replyVerified).toBe(false);
    expect(github.repliesPosted).toHaveLength(1);

    await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 2,
    });

    expect(github.repliesPosted).toHaveLength(1);
    const after2 = repo.getComment(runId, 9001);
    expect(after2?.state).toBe('blocked');
    expect(after2?.replyVerified).toBe(false);
  });
});

describe('ProcessPrReviewComments — APPROVED review filtering', () => {
  it('excludes inline comments from APPROVED reviews', async () => {
    const { deps, github, repo } = makeDeps({
      extractResult: async () => ({
        ok: true,
        result: {
          outcome: 'ALL_DONE',
          comments: [{ commentId: 9002, action: 'fixed', replyBody: 'Fixed the issue.' }],
        },
      }),
    });
    github.reviews.set('o/r/5', [{ id: 100, state: 'APPROVED' as const, user: 'approver' }]);
    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'approver',
        body: 'LGTM but minor nits',
        createdAt: new Date('2026-06-04T00:00:00Z'),
        reviewId: 100,
      },
      {
        id: 9002,
        prNumber: 5,
        path: 'b.ts',
        line: 5,
        reviewer: 'reviewer2',
        body: 'please fix this',
        createdAt: new Date('2026-06-04T00:00:00Z'),
      },
    ]);

    const uc = new ProcessPrReviewComments(deps);
    const out = await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 1,
    });

    expect(out.outcome).toBe('ALL_DONE');
    expect(out.processed).toBe(1);
    expect(out.blocked).toBe(0);
    expect(out.allResolved).toBe(true);

    // Comment 9001 (from APPROVED review) should never have been fetched or processed
    expect(repo.getComment(runId, 9001)).toBeUndefined();
    expect(github.repliesPosted.some((r) => r.commentId === 9001)).toBe(false);

    // Comment 9002 (not from an APPROVED review) was processed normally
    expect(github.repliesPosted.some((r) => r.commentId === 9002)).toBe(true);
    expect(repo.getComment(runId, 9002)?.state).toBe('processed');
  });
});

describe('ProcessPrReviewComments — Bug R fallback for omitted comment IDs', () => {
  it('posts fallback replies for omitted comments when agent returns ALL_DONE with missing comment IDs', async () => {
    const { deps, github } = makeDeps({
      extractResult: async () => ({
        ok: true,
        result: {
          outcome: 'ALL_DONE',
          comments: [{ commentId: 9001, action: 'fixed', replyBody: 'Fixed the typo.' }],
        },
      }),
    });
    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 1,
        reviewer: 'r1',
        body: 'typo',
        createdAt: new Date(),
      },
      {
        id: 9002,
        prNumber: 5,
        path: 'b.ts',
        line: 2,
        reviewer: 'r2',
        body: 'bug',
        createdAt: new Date(),
      },
    ]);
    const uc = new ProcessPrReviewComments(deps);
    const out = await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 1,
    });
    expect(out.outcome).toBe('ALL_DONE');
    expect(github.repliesPosted.some((r) => r.commentId === 9001)).toBe(true);
    expect(
      github.repliesPosted.some((r) => r.commentId === 9002 && r.body.includes('commit')),
    ).toBe(true);
  });

  it('verifyOrphaned verifies fallback replies and sets allResolved=true', async () => {
    const { deps, github, git } = makeDeps({
      extractResult: async () => ({
        ok: true,
        result: {
          outcome: 'ALL_DONE',
          comments: [{ commentId: 9001, action: 'fixed', replyBody: 'Fixed the typo.' }],
        },
      }),
    });
    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 1,
        reviewer: 'r1',
        body: 'typo',
        createdAt: new Date(),
      },
      {
        id: 9002,
        prNumber: 5,
        path: 'b.ts',
        line: 2,
        reviewer: 'r2',
        body: 'bug',
        createdAt: new Date(),
      },
    ]);
    git.remoteRefs.set('origin/feat-x', 'def456');
    git.ancestorResults.set('def456|def456', true);
    git.logBetweenResults.set('abc123|def456', ['def456']);

    const uc = new ProcessPrReviewComments(deps);
    const out = await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 1,
    });

    expect(out.outcome).toBe('ALL_DONE');
    expect(out.allResolved).toBe(true);
    expect(
      github.repliesPosted.some((r) => r.commentId === 9002 && r.body.includes('commit')),
    ).toBe(true);
    expect(github.resolvedThreads.some((t) => t.commentId === 9002)).toBe(true);
  });
});

describe('ProcessPrReviewComments — closed PR guard', () => {
  it('blocks without invoking the agent when the PR is closed', async () => {
    const { deps, github, repo, agent } = makeDeps();
    github.prs.set('o/r/5', {
      number: 5,
      url: 'https://x/pr/5',
      state: 'closed',
      headRefName: 'feat-x',
    });
    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'rename foo',
        createdAt: new Date('2026-06-04T00:00:00Z'),
      },
    ]);
    const uc = new ProcessPrReviewComments(deps);
    const out = await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 1,
    });
    expect(out.outcome).toBe('BLOCKED');
    expect(out.processed).toBe(0);
    expect(out.blocked).toBe(0);
    expect(out.allResolved).toBe(false);
    expect(agent.invocations.length).toBe(0);
    expect(github.repliesPosted).toHaveLength(0);
    const poll = repo.latestPollAttempt(runId);
    expect(poll?.status).toBe('failed');
  });

  it('blocks without invoking the agent when the PR is merged', async () => {
    const { deps, github, agent } = makeDeps();
    github.prs.set('o/r/5', {
      number: 5,
      url: 'https://x/pr/5',
      state: 'merged',
      headRefName: 'feat-x',
    });
    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'rename foo',
        createdAt: new Date('2026-06-04T00:00:00Z'),
      },
    ]);
    const uc = new ProcessPrReviewComments(deps);
    const out = await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 1,
    });
    expect(out.outcome).toBe('BLOCKED');
    expect(agent.invocations.length).toBe(0);
  });
});

describe('ProcessPrReviewComments — verifyCommitPushed anchors to fixCommitSha (C1)', () => {
  it('rejects verification when a different agent run pushed the commit', async () => {
    const sharedStart = 'sharedStartSha';
    const agentACommit = 'aaa111fix';
    const agentBCommit = 'bbb222fix';

    const git = new TwoShaGitPort(sharedStart, agentACommit);
    const verifyCalls: Array<{
      cwd: string;
      branch: string;
      startCommitSha: string;
      commitSha?: string;
    }> = [];
    const { deps, github, repo } = makeDeps({
      git,
      verifyCommitPushed: async (input) => {
        verifyCalls.push(input);
        return input.commitSha === agentBCommit;
      },
    });

    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'rename foo',
        createdAt: new Date('2026-06-04T00:00:00Z'),
      },
      {
        id: 9002,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'agent',
        body: 'Fixed.',
        createdAt: new Date('2026-06-04T00:05:00Z'),
        inReplyToId: 9001,
      },
    ]);

    const uc = new ProcessPrReviewComments(deps);
    const out = await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 1,
    });

    expect(verifyCalls.length).toBe(2);
    expect(verifyCalls[0].commitSha).toBe(agentACommit);
    expect(verifyCalls[0].startCommitSha).toBe(sharedStart);
    expect(verifyCalls[1].commitSha).toBe(agentACommit);

    expect(out.processed).toBe(0);
    const comment = repo.getComment(runId, 9001);
    expect(comment?.state).not.toBe('processed');
  });

  it('accepts verification when the correct agent run pushed the commit', async () => {
    const sharedStart = 'sharedStartSha';
    const agentBCommit = 'bbb222fix';

    const git = new TwoShaGitPort(sharedStart, agentBCommit);
    const verifyCalls: Array<{
      cwd: string;
      branch: string;
      startCommitSha: string;
      commitSha?: string;
    }> = [];
    const { deps, github, repo } = makeDeps({
      git,
      verifyCommitPushed: async (input) => {
        verifyCalls.push(input);
        return input.commitSha === agentBCommit;
      },
    });

    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'rename foo',
        createdAt: new Date('2026-06-04T00:00:00Z'),
      },
      {
        id: 9002,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'agent',
        body: 'Fixed.',
        createdAt: new Date('2026-06-04T00:05:00Z'),
        inReplyToId: 9001,
      },
    ]);

    const uc = new ProcessPrReviewComments(deps);
    const out = await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 1,
    });

    expect(verifyCalls.length).toBe(1);
    expect(verifyCalls[0].commitSha).toBe(agentBCommit);
    expect(verifyCalls[0].startCommitSha).toBe(sharedStart);

    expect(out.processed).toBe(1);
    const comment = repo.getComment(runId, 9001);
    expect(comment?.state).toBe('processed');
  });
});

describe('ProcessPrReviewComments — verifyCommitPushed rejects force-push / squash-merge (C2)', () => {
  it('does not mark comment processed when a squash-merge replaced the branch tip with unrelated commits', async () => {
    const agentCommit = 'agentFixSha';

    const git = new TwoShaGitPort('startSha', agentCommit);
    const verifyCalls: Array<{
      cwd: string;
      branch: string;
      startCommitSha: string;
      commitSha?: string;
    }> = [];
    const { deps, github, repo } = makeDeps({
      git,
      verifyCommitPushed: async (input) => {
        verifyCalls.push(input);
        return false;
      },
    });

    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'rename foo',
        createdAt: new Date('2026-06-04T00:00:00Z'),
      },
      {
        id: 9002,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'agent',
        body: 'Fixed.',
        createdAt: new Date('2026-06-04T00:05:00Z'),
        inReplyToId: 9001,
      },
    ]);

    const uc = new ProcessPrReviewComments(deps);
    const out = await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 1,
    });

    expect(verifyCalls.length).toBeGreaterThanOrEqual(1);
    expect(verifyCalls[0].commitSha).toBe(agentCommit);
    expect(verifyCalls[0].startCommitSha).toBe('startSha');

    expect(out.processed).toBe(0);
    const comment = repo.getComment(runId, 9001);
    expect(comment?.state).not.toBe('processed');
  });

  it('does not mark comment processed when no commitSha is available (orphaned without fix)', async () => {
    const git = new FakeGitPort();
    const repo = new FakePrReviewRepository();
    const github = new FakeGitHubPort();
    const agent = new FakeAgentPort({
      'post-pr-review-profile': [makeSuccessAgentResult()],
    });

    const seeded = createPrReviewComment({
      runId,
      prNumber: 5,
      commentId: 9001,
      path: 'a.ts',
      line: 3,
      reviewer: 'octocat',
      body: 'rename foo',
      now: new Date('2026-06-04T00:00:00Z'),
    });
    repo.upsertComment({
      ...seeded,
      state: 'replied',
      outcome: 'fixed',
      attempts: 1,
      replyVerified: false,
    });

    github.prs.set('o/r/5', {
      number: 5,
      headRefName: 'feat-x',
      state: 'open',
    });
    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'rename foo',
        createdAt: new Date('2026-06-04T00:00:00Z'),
      },
    ]);
    git.remoteRefs.set('origin/feat-x', 'remotesha');

    let verifyCalledWithoutCommitSha = false;
    const deps: ProcessPrReviewDeps = {
      github,
      git,
      agent,
      prReviewRepo: repo,
      renderPrompt: async () => '/tmp/prompt.md',
      extractResult: async () => ({
        ok: true,
        result: {
          outcome: 'ALL_DONE',
          comments: [],
        },
      }),
      verifyCommitPushed: async (input) => {
        if (!input.commitSha) verifyCalledWithoutCommitSha = true;
        return false;
      },
      verifyBuildPasses: async () => true,
      resolveProfileForPhase: () => 'post-pr-review-profile' as never,
      idFactory: () => 'id-1',
      now: () => new Date('2026-06-04T00:10:00Z'),
      maxIterations: 10,
    };

    const uc = new ProcessPrReviewComments(deps);
    await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 1,
    });

    expect(verifyCalledWithoutCommitSha).toBe(false);
    const comment = repo.getComment(runId, 9001);
    expect(comment?.state).not.toBe('processed');
  });
});

describe('ProcessPrReviewComments — local main checkout guard', () => {
  it('emits a warning when local main checkout HEAD changes during agent run', async () => {
    const git = new FakeGitPort();
    git.headByCwd.set('/work/tree', 'abc123');
    git.remoteRefs.set('origin/feat-x', 'abc123');

    let headShaOfCalls = 0;
    git.headCommitShaOfResults.set('/repo/root', 'aaa111');
    const originalHeadCommitShaOf = git.headCommitShaOf.bind(git);
    git.headCommitShaOf = async (cwd: string) => {
      if (cwd === '/repo/root') {
        headShaOfCalls++;
        return headShaOfCalls <= 1 ? 'aaa111' : 'bbb222';
      }
      return originalHeadCommitShaOf(cwd);
    };

    const github = new FakeGitHubPort();
    const repo = new FakePrReviewRepository();
    const agent = new FakeAgentPort({
      'post-pr-review-profile': [makeSuccessAgentResult()],
    });

    github.prs.set('o/r/5', {
      number: 5,
      url: 'https://x/pr/5',
      state: 'open',
      headRefName: 'feat-x',
    });
    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'rename foo',
        createdAt: new Date('2026-06-04T00:00:00Z'),
      },
    ]);

    const warnings: Array<{ message: string; metadata: Record<string, unknown> }> = [];
    const deps: ProcessPrReviewDeps = {
      github,
      git,
      agent,
      prReviewRepo: repo,
      renderPrompt: async () => '/tmp/prompt.md',
      extractResult: async () => ({
        ok: true,
        result: {
          outcome: 'ALL_DONE',
          comments: [{ commentId: 9001, action: 'fixed', replyBody: 'Renamed foo to bar.' }],
        },
      }),
      verifyCommitPushed: async () => true,
      verifyBuildPasses: async () => true,
      resolveProfileForPhase: () => 'post-pr-review-profile' as never,
      idFactory: () => 'id-1',
      now: () => new Date('2026-06-04T00:10:00Z'),
      maxIterations: 10,
      baseBranch: 'main',
      repoRoot: '/repo/root',
      onWarning: (message, metadata) => {
        warnings.push({ message, metadata });
      },
    };

    const uc = new ProcessPrReviewComments(deps);
    await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 1,
    });

    expect(warnings).toContainEqual({
      message: 'local main checkout changed during agent run',
      metadata: expect.objectContaining({
        baseBranch: 'main',
        shaBefore: 'aaa111',
        shaAfter: 'bbb222',
        prNumber: 5,
      }),
    });
  });

  it('does not emit a warning when local main checkout HEAD is unchanged', async () => {
    const git = new FakeGitPort();
    git.headByCwd.set('/work/tree', 'abc123');
    git.remoteRefs.set('origin/feat-x', 'abc123');
    git.headCommitShaOfResults.set('/repo/root', 'aaa111');

    const github = new FakeGitHubPort();
    const repo = new FakePrReviewRepository();
    const agent = new FakeAgentPort({
      'post-pr-review-profile': [makeSuccessAgentResult()],
    });

    github.prs.set('o/r/5', {
      number: 5,
      url: 'https://x/pr/5',
      state: 'open',
      headRefName: 'feat-x',
    });
    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'rename foo',
        createdAt: new Date('2026-06-04T00:00:00Z'),
      },
    ]);

    const warnings: Array<{ message: string; metadata: Record<string, unknown> }> = [];
    const deps: ProcessPrReviewDeps = {
      github,
      git,
      agent,
      prReviewRepo: repo,
      renderPrompt: async () => '/tmp/prompt.md',
      extractResult: async () => ({
        ok: true,
        result: {
          outcome: 'ALL_DONE',
          comments: [{ commentId: 9001, action: 'fixed', replyBody: 'Renamed foo to bar.' }],
        },
      }),
      verifyCommitPushed: async () => true,
      verifyBuildPasses: async () => true,
      resolveProfileForPhase: () => 'post-pr-review-profile' as never,
      idFactory: () => 'id-1',
      now: () => new Date('2026-06-04T00:10:00Z'),
      maxIterations: 10,
      baseBranch: 'main',
      repoRoot: '/repo/root',
      onWarning: (message, metadata) => {
        warnings.push({ message, metadata });
      },
    };

    const uc = new ProcessPrReviewComments(deps);
    await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 1,
    });

    expect(warnings).toEqual([]);
  });
});
