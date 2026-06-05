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

function makeSuccessAgentResult(): AgentInvocationResult {
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
  };
}

function makeDeps(overrides: Partial<ProcessPrReviewDeps> = {}): {
  deps: ProcessPrReviewDeps;
  github: FakeGitHubPort;
  git: FakeGitPort;
  repo: FakePrReviewRepository;
  agent: FakeAgentPort;
} {
  const github = new FakeGitHubPort();
  const git = new FakeGitPort();
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
  git.headByCwd.set('/work/tree', 'abc123');
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
    eventBus: { publish: () => {}, subscribe: () => () => {} } as never,
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
    repo.getComment(runId, 9001);
    expect(repo.getComment(runId, 9001)?.state).toBe('processed');
  });
});

describe('ProcessPrReviewComments — blocking', () => {
  it('blocks a comment after two failed verification attempts', async () => {
    const agent = new FakeAgentPort({
      'post-pr-review-profile': [makeSuccessAgentResult(), makeSuccessAgentResult()],
    });
    const { deps, repo } = makeDeps({
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
    expect(after1?.state).toBe('pending');
    expect(after1?.attempts).toBe(1);
    const out2 = await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 2,
    });
    const after2 = repo.getComment(runId, 9001);
    expect(after2?.state).toBe('blocked');
    expect(out2.blocked).toBe(1);
  });
});
