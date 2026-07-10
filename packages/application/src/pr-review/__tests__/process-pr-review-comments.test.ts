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

// Models real HEAD progression: every read returns a fresh SHA, so each agent
// "commit" looks like a distinct new commit. Robust for multi-task passes where
// several comments each produce their own commit. (replaces call-count fixtures — M3)
//
// isAncestor and logBetween use blanket overrides (true / ['dummy']) because tests
// using this port exercise the task-loop orchestration — they don't assert on ancestry
// or commit-range logic. These overrides intentionally bypass the parent FakeGitPort's
// per-key ancestorResults/logBetweenResults maps.
//
// Tests that DO assert on ancestry/log behavior should either:
//   (a) Pass a TwoShaGitPort or FakeGitPort via makeDeps({ git }), then set
//       per-key entries on .ancestorResults and .logBetweenResults; or
//   (b) Keep IncrementingShaGitPort but override isAncestor/logBetween with
//       specific key lookups matching the incrementing SHAs.
class IncrementingShaGitPort extends FakeGitPort {
  private n = 0;
  override async headCommitSha(_cwd: string): Promise<string> {
    return `sha-${++this.n}`;
  }
  override async isAncestor(
    _cwd: string,
    _ancestor: string,
    _descendant: string,
  ): Promise<boolean> {
    return true;
  }
  override async logBetween(_cwd: string, _base: string, _head: string): Promise<string[]> {
    return ['dummy'];
  }
}

// Two-SHA before/after model, used by tests that specifically assert SHA
// anchoring of commit verification (C1/C2).
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
    return this.callCount <= 2 ? this.firstSha : this.secondSha;
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
  const git = new IncrementingShaGitPort();
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
  // Mirror production: the prompt is rendered per batch and the agent's
  // result.json carries results for those comments.
  let currentCommentIds: number[] = [];
  const deps: ProcessPrReviewDeps = {
    github,
    git,
    agent,
    prReviewRepo: repo,
    renderTaskPrompt: async ({ comments }: { comments: import("@ai-sdlc/domain").PrReviewComment[] }) => {
      currentCommentIds = comments.map((c) => c.commentId);
      return '/tmp/prompt.md';
    },
    extractTaskResult: async () => {
      const result: Record<string, { action: string; replyBody: string }> = {};
      for (const id of currentCommentIds) {
        result[String(id)] = { action: 'fixed', replyBody: 'Renamed foo to bar.' };
      }
      return {
        ok: true,
        result,
      };
    },
    verifyCommitPushed: async () => true,
    verifyBuildPasses: async () => ({ passed: true }),
    resolveProfileForPhase: () => 'post-pr-review-profile' as never,
    idFactory: () => `id-${++replyCounter}`,
    now: () => new Date('2026-06-04T00:10:00Z'),
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

    expect(out.outcome).toBe('ALL_RESOLVED');
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
      verifyBuildPasses: async () => ({ passed: false }),
      extractTaskResult: async () => ({
        ok: true,
        result: { "9001": { action: 'fixed', replyBody: 'attempted fix' } },
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
    expect(repo.getComment(runId, 9001)?.state).toBe('blocked');
    expect(out.blocked).toBe(1);
    expect(github.repliesPosted).toHaveLength(0);
  });
});

describe('ProcessPrReviewComments — invalid result', () => {
  it('blocks the comment after retries and posts no replies when extractTaskResult fails', async () => {
    const agent = new FakeAgentPort({
      'post-pr-review-profile': [
        makeSuccessAgentResult(),
        makeSuccessAgentResult(),
        makeSuccessAgentResult(),
      ],
    });
    const { deps, github, repo } = makeDeps({
      agent,
      extractTaskResult: async () => ({
        ok: false,
        reason: 'invalid_result',
        detail: 'result.json missing action field',
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
    expect(out.outcome).toBe('PARTIAL_PROGRESS');
    expect(out.blocked).toBe(1);
    expect(github.repliesPosted).toHaveLength(0);
    expect(repo.getComment(runId, 9001)?.state).toBe('blocked');
    const poll = repo.latestPollAttempt(runId);
    expect(poll?.status).toBe('completed');
    expect(poll?.terminalState).toBe('blocked');
  });
});

describe('ProcessPrReviewComments — no_fix action', () => {
  it('marks a no_fix comment processed without commit/build verification', async () => {
    const { deps, github, repo } = makeDeps({
      extractTaskResult: async () => ({
        ok: true,
        result: { "9001": { action: 'no_fix', replyBody: 'Intentional design choice.' } },
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
    expect(out.outcome).toBe('ALL_RESOLVED');
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
  it('processes a mix of fixed, no_fix, and blocked comments in one pass', async () => {
    const agent = new FakeAgentPort({
      'post-pr-review-profile': [
        makeSuccessAgentResult(),
        makeSuccessAgentResult(),
        makeSuccessAgentResult(),
      ],
    });
    // Keyed by comment id (not call order): the result returned matches whichever
    // comment is currently being processed, mirroring production. (M3)
    const resultsById: Record<
      number,
      { action: 'fixed' | 'no_fix' | 'blocked'; replyBody: string; blockedReason?: string }
    > = {
      9001: { action: 'fixed', replyBody: 'Fixed the typo.' },
      9002: { action: 'no_fix', replyBody: 'Intentional.' },
      9003: { action: 'blocked', replyBody: 'Cannot fix safely.', blockedReason: 'unsafe change' },
    };
    const { deps, github, repo } = makeDeps({
      agent,
      renderTaskPrompt: async ({ comments }: { comments: import("@ai-sdlc/domain").PrReviewComment[] }) => {
        activeCommentIds = comments.map(c => c.commentId);
        return '/tmp/prompt.md';
      },
      extractTaskResult: async () => ({
        ok: true,
        result: Object.fromEntries(activeCommentIds.map(id => [id, resultsById[id]])) ,
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

    expect(out.outcome).toBe('PARTIAL_PROGRESS');
    expect(out.processed).toBe(2);
    expect(out.blocked).toBe(1);
    expect(repo.getComment(runId, 9001)?.state).toBe('processed');
    expect(repo.getComment(runId, 9002)?.state).toBe('processed');
    expect(repo.getComment(runId, 9003)?.state).toBe('blocked');
  });
});

describe('ProcessPrReviewComments — failed agent invocation', () => {
  it('makes no commit and blocks the comment when the agent invocation fails', async () => {
    const agent = new FakeAgentPort({
      'post-pr-review-profile': [
        makeSuccessAgentResult({ outcome: 'failed' }),
        makeSuccessAgentResult({ outcome: 'failed' }),
        makeSuccessAgentResult({ outcome: 'failed' }),
      ],
    });
    const git = new FakeGitPort();
    git.headByCwd.set('/work/tree', 'abc123');
    git.remoteRefs.set('origin/feat-x', 'abc123');
    const { deps, github, repo } = makeDeps({ agent, git });
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
    expect(repo.getComment(runId, 9001)?.state).toBe('blocked');
  });

  it('blocks the comment and posts no replies when agent invocation fails', async () => {
    const agent = new FakeAgentPort({
      'post-pr-review-profile': [
        makeSuccessAgentResult({ outcome: 'failed' }),
        makeSuccessAgentResult({ outcome: 'failed' }),
        makeSuccessAgentResult({ outcome: 'failed' }),
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
    expect(out.outcome).toBe('PARTIAL_PROGRESS');
    expect(out.blocked).toBe(1);
    expect(github.repliesPosted).toHaveLength(0);
    const poll = repo.latestPollAttempt(runId);
    expect(poll?.terminalState).toBe('blocked');
  });

  it('blocks the comment when agent invocation times out', async () => {
    const agent = new FakeAgentPort({
      'post-pr-review-profile': [
        makeSuccessAgentResult({ outcome: 'timeout' }),
        makeSuccessAgentResult({ outcome: 'timeout' }),
        makeSuccessAgentResult({ outcome: 'timeout' }),
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
    expect(out.outcome).toBe('PARTIAL_PROGRESS');
    expect(out.blocked).toBe(1);
    expect(github.repliesPosted).toHaveLength(0);
    expect(repo.getComment(runId, 9001)?.state).toBe('blocked');
  });

  it('blocks the comment when agent invocation has contract violations', async () => {
    const agent = new FakeAgentPort({
      'post-pr-review-profile': [
        makeSuccessAgentResult({
          outcome: 'contract_violation',
          contractViolations: ['missing result.json'],
        }),
        makeSuccessAgentResult({
          outcome: 'contract_violation',
          contractViolations: ['missing result.json'],
        }),
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
    expect(out.outcome).toBe('PARTIAL_PROGRESS');
    expect(out.blocked).toBe(1);
    expect(github.repliesPosted).toHaveLength(0);
    expect(repo.getComment(runId, 9001)?.state).toBe('blocked');
  });
});

describe('ProcessPrReviewComments — per-task retry budget', () => {
  it('retries a failing task ESCALATION_BUDGET times before blocking the comment', async () => {
    const agent = new FakeAgentPort({
      'post-pr-review-profile': [
        makeSuccessAgentResult({ outcome: 'failed' }),
        makeSuccessAgentResult({ outcome: 'failed' }),
        makeSuccessAgentResult({ outcome: 'failed' }),
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
    expect(agent.invocations.length).toBe(3);
    expect(out.blocked).toBe(1);
    expect(repo.getComment(runId, 9001)?.state).toBe('blocked');
  });

  it('retries with build error feedback when verification fails', async () => {
    let promptCallCount = 0;
    const capturedPrompts: unknown[] = [];
    const agent = new FakeAgentPort({
      'post-pr-review-profile': [
        makeSuccessAgentResult(),
        makeSuccessAgentResult(),
        makeSuccessAgentResult(),
      ],
    });
    const { deps, github } = makeDeps({
      agent,
      verifyBuildPasses: async () => ({ passed: false, error: 'TS2322: Type mismatch' }),
      renderTaskPrompt: async (input) => {
        promptCallCount++;
        capturedPrompts.push(input);
        return '/tmp/prompt.md';
      },
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
    expect(promptCallCount).toBe(3);
    expect((capturedPrompts[0] as Record<string, unknown>).previousBuildError).toBeUndefined();
    expect((capturedPrompts[1] as Record<string, unknown>).previousBuildError).toBe(
      'TS2322: Type mismatch',
    );
    expect(out.blocked).toBe(1);
  });
});

describe('ProcessPrReviewComments — commit SHA change required for fixed', () => {
  it('blocks a fixed comment when the agent did not produce a new commit', async () => {
    const git = new FakeGitPort();
    git.headByCwd.set('/work/tree', 'abc123');
    git.remoteRefs.set('origin/feat-x', 'xyz789');
    const agent = new FakeAgentPort({
      'post-pr-review-profile': [
        makeSuccessAgentResult(),
        makeSuccessAgentResult(),
        makeSuccessAgentResult(),
      ],
    });
    const { deps, github, repo } = makeDeps({ git, agent });
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

describe('ProcessPrReviewComments — agent blocks a comment', () => {
  it('blocks a comment when the agent returns a blocked action', async () => {
    const { deps, github, repo } = makeDeps({
      extractTaskResult: async () => ({
        ok: true,
        result: { "9001": {

          action: 'blocked',
          replyBody: 'Cannot fix this safely.',
          blockedReason: 'blocked by agent',
        },
       } }),
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
    expect(out.outcome).toBe('PARTIAL_PROGRESS');
    expect(out.blocked).toBe(1);
    expect(out.processed).toBe(0);
    expect(out.allResolved).toBe(false);
    expect(repo.getComment(runId, 9001)?.state).toBe('blocked');
    expect(github.repliesPosted).toHaveLength(1);
    const poll = repo.latestPollAttempt(runId);
    expect(poll?.terminalState).toBe('blocked');
  });
});

describe('ProcessPrReviewComments — replied with failed verification prevents allResolved', () => {
  it('does not report allResolved when a replied comment has unverified reply', async () => {
    const agent = new FakeAgentPort({
      'post-pr-review-profile': [
        makeSuccessAgentResult(),
        makeSuccessAgentResult(),
        makeSuccessAgentResult(),
      ],
    });
    const { deps, github, repo } = makeDeps({
      agent,
      verifyBuildPasses: async () => ({ passed: false }),
      extractTaskResult: async () => ({
        ok: true,
        result: { "9001": { action: 'fixed', replyBody: 'attempted fix' } },
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

    // Retry loop exhausts budget and blocks the comment immediately
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

describe('ProcessPrReviewComments — per-task failure isolation', () => {
  it('blocks the failing comment while still processing the succeeding one', async () => {
    const agent = new FakeAgentPort({
      'post-pr-review-profile': [
        makeSuccessAgentResult({ outcome: 'failed' }),
        makeSuccessAgentResult({ outcome: 'failed' }),
        makeSuccessAgentResult({ outcome: 'failed' }),
        makeSuccessAgentResult(),
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
      {
        id: 9002,
        prNumber: 5,
        path: 'b.ts',
        line: 10,
        reviewer: 'reviewer2',
        body: 'rename bar',
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

    expect(out.outcome).toBe('PARTIAL_PROGRESS');
    expect(out.processed).toBe(1);
    expect(out.blocked).toBe(1);
    expect(repo.getComment(runId, 9001)?.state).toBe('blocked');
    expect(repo.getComment(runId, 9002)?.state).toBe('processed');
  });
});

describe('ProcessPrReviewComments — reset to pending on failed verification', () => {
  it('resets comment to pending after failed verification, then blocks when budget exhausted', async () => {
    const agent = new FakeAgentPort({
      'post-pr-review-profile': [
        makeSuccessAgentResult(),
        makeSuccessAgentResult(),
        makeSuccessAgentResult(),
      ],
    });
    const { deps, github, repo } = makeDeps({
      agent,
      verifyBuildPasses: async () => ({ passed: false }),
      extractTaskResult: async () => ({
        ok: true,
        result: { "9001": { action: 'fixed', replyBody: 'attempted fix' } },
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

    // Retry loop exhausts budget and blocks the comment immediately.
    const after1 = repo.getComment(runId, 9001);
    expect(after1?.state).toBe('blocked');
    expect(after1?.replyVerified).toBe(false);
    expect(github.repliesPosted).toHaveLength(0);
    expect(out.blocked).toBe(1);
  });
});

describe('ProcessPrReviewComments — build failure feedback', () => {
  it('passes the previous build error into the next retry attempt', async () => {
    const agent = new FakeAgentPort({
      'post-pr-review-profile': [makeSuccessAgentResult(), makeSuccessAgentResult()],
    });
    const capturedErrors: Array<string | undefined> = [];
    let buildChecks = 0;
    const order: string[] = [];
    const { deps, github, repo, git } = makeDeps({
      agent,
      renderTaskPrompt: async (input) => {
        capturedErrors.push(input.previousBuildError);
        order.push(`prompt:${input.previousBuildError ?? 'none'}`);
        return '/tmp/prompt.md';
      },
      verifyBuildPasses: async () => {
        order.push('build');
        return buildChecks++ === 0
          ? { passed: false, error: 'TS2722: Cannot invoke object' }
          : { passed: true };
      },
      extractTaskResult: async () => ({
        ok: true,
        result: { "9001": { action: 'fixed', replyBody: 'attempted fix' } },
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

    expect(out.outcome).toBe('ALL_RESOLVED');
    expect(capturedErrors).toEqual([undefined, 'TS2722: Cannot invoke object']);
    expect(git.pushes).toHaveLength(1);
    expect(github.repliesPosted).toHaveLength(1);
    expect(repo.getComment(runId, 9001)?.state).toBe('processed');
    expect(order).toEqual([
      'prompt:none',
      'build',
      'prompt:TS2722: Cannot invoke object',
      'build',
      'build',
    ]);
  });
});

describe('ProcessPrReviewComments — APPROVED review filtering', () => {
  it('excludes inline comments from APPROVED reviews', async () => {
    const { deps, github, repo } = makeDeps();
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

    expect(out.outcome).toBe('ALL_RESOLVED');
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

describe('ProcessPrReviewComments — every comment gets its own task', () => {
  it('processes every unresolved comment independently (no comment can be omitted)', async () => {
    const agent = new FakeAgentPort({
      'post-pr-review-profile': [makeSuccessAgentResult(), makeSuccessAgentResult()],
    });
    const { deps, github, repo, git } = makeDeps({ agent });
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
    expect(out.outcome).toBe('ALL_RESOLVED');
    expect(out.processed).toBe(2);
    expect(github.repliesPosted.some((r) => r.commentId === 9001)).toBe(true);
    expect(github.repliesPosted.some((r) => r.commentId === 9002)).toBe(true);
    expect(repo.getComment(runId, 9001)?.state).toBe('processed');
    expect(repo.getComment(runId, 9002)?.state).toBe('processed');
    expect(git.pushes).toHaveLength(2);
    expect(git.pushes.map((p) => p.branch)).toEqual(['feat-x', 'feat-x']);
  });

  it('resolves every comment independently and reports allResolved', async () => {
    const agent = new FakeAgentPort({
      'post-pr-review-profile': [makeSuccessAgentResult(), makeSuccessAgentResult()],
    });
    const { deps, github } = makeDeps({ agent });
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

    expect(out.outcome).toBe('ALL_RESOLVED');
    expect(out.allResolved).toBe(true);
    expect(github.resolvedThreads.some((t) => t.commentId === 9001)).toBe(true);
    expect(github.resolvedThreads.some((t) => t.commentId === 9002)).toBe(true);
  });
});

describe('ProcessPrReviewComments — start SHA advances per task (M1)', () => {
  it('verifies a later task against the previous task’s commit, not the stale poll-start SHA', async () => {
    const agent = new FakeAgentPort({
      'post-pr-review-profile': [makeSuccessAgentResult(), makeSuccessAgentResult()],
    });
    const verifyCalls: Array<{ startCommitSha: string; commitSha?: string }> = [];
    const { deps, github, git } = makeDeps({
      agent,
      verifyCommitPushed: async (input) => {
        verifyCalls.push({ startCommitSha: input.startCommitSha, commitSha: input.commitSha });
        return true;
      },
    });
    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 1,
        reviewer: 'r1',
        body: 'first',
        createdAt: new Date(),
      },
      {
        id: 9002,
        prNumber: 5,
        path: 'b.ts',
        line: 2,
        reviewer: 'r2',
        body: 'second',
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

    expect(git.pushes).toHaveLength(2);
    expect(verifyCalls).toHaveLength(2);
    // The second task's start SHA must differ from the first task's start SHA,
    // proving the loop reads git HEAD before each task rather than staying
    // pinned to the poll-start SHA. (M1)
    expect(verifyCalls[1]!.startCommitSha).not.toBe(verifyCalls[0]!.startCommitSha);
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
    expect(verifyCalls[0]!.commitSha).toBe(agentACommit);
    expect(verifyCalls[0]!.startCommitSha).toBe(sharedStart);

    expect(out.processed).toBe(0);
    const comment = repo.getComment(runId, 9001);
    expect(comment?.state).not.toBe('processed');
  });

  it('accepts verification when the correct agent run pushed the commit', async () => {
    const sharedStart = 'sharedStartSha';
    const agentBCommit = 'bbb222fix';

    const git = new TwoShaGitPort(sharedStart, agentBCommit);
    git.remoteRefs.set('origin/feat-x', agentBCommit);
    git.ancestorResults.set(`${agentBCommit}|${agentBCommit}`, true);
    git.logBetweenResults.set(`${sharedStart}|${agentBCommit}`, [agentBCommit]);
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
    expect(verifyCalls[0]!.commitSha).toBe(agentBCommit);
    expect(verifyCalls[0]!.startCommitSha).toBe(sharedStart);

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
    expect(verifyCalls[0]!.commitSha).toBe(agentCommit);
    expect(verifyCalls[0]!.startCommitSha).toBe('startSha');

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
      renderTaskPrompt: async () => '/tmp/prompt.md',
      extractTaskResult: async () => ({
        ok: true,
        result: { "9001": { action: 'fixed', replyBody: 'Renamed foo to bar.' } },
      }),
      verifyCommitPushed: async (input) => {
        if (!input.commitSha) verifyCalledWithoutCommitSha = true;
        return false;
      },
      verifyBuildPasses: async () => ({ passed: true }),
      resolveProfileForPhase: () => 'post-pr-review-profile' as never,
      idFactory: () => 'id-1',
      now: () => new Date('2026-06-04T00:10:00Z'),
    };

    const uc = new ProcessPrReviewComments(deps);
    git.headByCwd.set("/work/tree", "startSha");
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
      renderTaskPrompt: async () => '/tmp/prompt.md',
      extractTaskResult: async () => ({
        ok: true,
        result: { "9001": { action: 'fixed', replyBody: 'Renamed foo to bar.' } },
      }),
      verifyCommitPushed: async () => true,
      verifyBuildPasses: async () => ({ passed: true }),
      resolveProfileForPhase: () => 'post-pr-review-profile' as never,
      idFactory: () => 'id-1',
      now: () => new Date('2026-06-04T00:10:00Z'),
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
      renderTaskPrompt: async () => '/tmp/prompt.md',
      extractTaskResult: async () => ({
        ok: true,
        result: { "9001": { action: 'fixed', replyBody: 'Renamed foo to bar.' } },
      }),
      verifyCommitPushed: async () => true,
      verifyBuildPasses: async () => ({ passed: true }),
      resolveProfileForPhase: () => 'post-pr-review-profile' as never,
      idFactory: () => 'id-1',
      now: () => new Date('2026-06-04T00:10:00Z'),
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

describe('ProcessPrReviewComments — timeout scaling', () => {
  it('scales agent timeout with unresolved comment count', async () => {
    const agent = new FakeAgentPort({
      'post-pr-review-profile': [
        makeSuccessAgentResult(),
        makeSuccessAgentResult(),
        makeSuccessAgentResult(),
      ],
    });
    const { deps, github } = makeDeps({ agent });
    // 3 unresolved comments
    github.comments.set('o/r/5', [
      {
        id: 1001,
        prNumber: 5,
        path: 'a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'fix this',
        createdAt: new Date('2026-06-04T00:00:00Z'),
      },
      {
        id: 1002,
        prNumber: 5,
        path: 'b.ts',
        line: 10,
        reviewer: 'reviewer2',
        body: 'fix that',
        createdAt: new Date('2026-06-04T00:00:00Z'),
      },
      {
        id: 1003,
        prNumber: 5,
        path: 'c.ts',
        line: 5,
        reviewer: 'reviewer3',
        body: 'fix the other',
        createdAt: new Date('2026-06-04T00:00:00Z'),
      },
    ]);
    const svc = new ProcessPrReviewComments(deps);
    await svc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 1,
    });
    // Each invocation should have timeoutMs = min(30, 10 + 5*3) * 60_000 = 1_500_000
    for (const inv of agent.invocations) {
      expect(inv.timeoutMs).toBe(1_500_000);
    }
  });
});

describe('ProcessPrReviewComments — rollback on budget exhaustion', () => {
  it('calls rollbackFix once with the pre-attempt SHA when all attempts fail the build', async () => {
    const rollbackCalls: Array<{ ctx: { cwd: string; branch: string }; sha: string }> = [];
    const agent = new FakeAgentPort({
      'post-pr-review-profile': [
        makeSuccessAgentResult(),
        makeSuccessAgentResult(),
        makeSuccessAgentResult(),
      ],
    });
    const { deps, repo } = makeDeps({
      agent,
      verifyBuildPasses: async () => ({ passed: false, error: 'TS2722: Type mismatch' }),
      rollbackFix: async (ctx, sha) => {
        rollbackCalls.push({ ctx, sha });
        return true;
      },
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

    expect(out.blocked).toBe(1);
    expect(repo.getComment(runId, 9001)?.state).toBe('blocked');
    expect(rollbackCalls).toHaveLength(1);
    expect(rollbackCalls[0].sha).toBe('sha-2');
    expect(rollbackCalls[0].ctx).toEqual({ cwd: '/work/tree', branch: 'feat-x' });
  });

  it('does not call rollbackFix when the comment is processed on the first attempt', async () => {
    const rollbackCalls: Array<unknown> = [];
    const { deps } = makeDeps({
      rollbackFix: async (ctx, sha) => {
        rollbackCalls.push({ ctx, sha });
        return true;
      },
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

    expect(out.processed).toBe(1);
    expect(rollbackCalls).toHaveLength(0);
  });

  it('does not call rollbackFix when the agent explicitly blocks the comment', async () => {
    const rollbackCalls: Array<unknown> = [];
    const { deps } = makeDeps({
      extractTaskResult: async () => ({
        ok: true,
        result: { "9001": {

          action: 'blocked' as const,
          replyBody: 'This change breaks type safety.',
          blockedReason: 'Type unsafe',
        },
       } }),
      rollbackFix: async (ctx, sha) => {
        rollbackCalls.push({ ctx, sha });
        return true;
      },
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

    expect(out.blocked).toBe(1);
    expect(rollbackCalls).toHaveLength(0);
  });
});

describe('ProcessPrReviewComments - codeVerified retry behavior', () => {
  it('passes codeVerifyReason into next attempt prompt when code verify fails', async () => {
    const agent = new FakeAgentPort({
      'post-pr-review-profile': [makeSuccessAgentResult(), makeSuccessAgentResult()],
    });
    const capturedPromptInputs: Array<{ previousCodeVerifyReason?: string }> = [];
    let verifyCallCount = 0;

    const { deps, github, git } = makeDeps({
      agent,
      verifyCodeChange: async () => {
        verifyCallCount++;
        if (verifyCallCount === 1) return { pass: false, reason: 'verifier rejected fix' };
        return { pass: true, reason: 'ok' };
      },
      renderTaskPrompt: async (input) => {
        capturedPromptInputs.push({ previousCodeVerifyReason: input.previousCodeVerifyReason });
        return `/tmp/prompt-${capturedPromptInputs.length}.md`;
      },
      extractTaskResult: async () => ({
        ok: true,
        result: { "9001": { action: 'fixed', replyBody: 'Fixed.' } },
      }),
    });

    const rc = {
      id: 9001,
      prNumber: 5,
      path: 'a.ts',
      line: 3,
      reviewer: 'octocat',
      body: 'fix please',
      createdAt: new Date(),
    };
    github.comments.set('o/r/5', [rc]);

    const result = await new ProcessPrReviewComments(deps).execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 1,
    });

    expect(result.processed).toBe(1);
    expect(capturedPromptInputs).toEqual([
      { previousCodeVerifyReason: undefined },
      { previousCodeVerifyReason: 'verifier rejected fix' },
    ]);
    expect(git.pushes).toHaveLength(1);
    expect(github.repliesPosted).toHaveLength(1);
  });

  it('reports not processed when all attempts exhaust with code verify failures', async () => {
    const agent = new FakeAgentPort({
      'post-pr-review-profile': [
        makeSuccessAgentResult(),
        makeSuccessAgentResult(),
        makeSuccessAgentResult(),
      ],
    });

    const rollbackCalls: Array<{ ctx: { cwd: string; branch: string }; sha: string }> = [];
    const { deps, github, git } = makeDeps({
      agent,
      verifyCodeChange: async () => ({ pass: false, reason: 'never satisfied' }),
      extractTaskResult: async () => ({
        ok: true,
        result: { "9001": { action: 'fixed', replyBody: 'Fixed.' } },
      }),
      rollbackFix: async (ctx, sha) => {
        rollbackCalls.push({ ctx, sha });
        return true;
      },
    });

    const rc = {
      id: 9001,
      prNumber: 5,
      path: 'a.ts',
      line: 3,
      reviewer: 'octocat',
      body: 'fix please',
      createdAt: new Date(),
    };
    github.comments.set('o/r/5', [rc]);

    const result = await new ProcessPrReviewComments(deps).execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 1,
    });

    expect(result.processed).toBe(0);
    expect(result.blocked).toBe(1);
    expect(rollbackCalls).toHaveLength(1);
    expect(git.pushes).toHaveLength(0);
  });
});
