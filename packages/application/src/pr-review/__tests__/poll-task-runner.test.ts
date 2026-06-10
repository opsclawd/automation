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
  PollTaskRunner,
  type PollTaskRunnerDeps,
  type PollTaskInput,
} from '../poll-task-runner.js';

const runId = RunId('44444444-4444-4444-4444-444444444444');
const repoId = RepositoryId('o/r');
const phaseId = PhaseName('post-pr-review');

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

function makeComment(overrides: Partial<ReturnType<typeof createPrReviewComment>> = {}) {
  return createPrReviewComment({
    runId,
    prNumber: 5,
    commentId: 9001,
    path: 'a.ts',
    line: 3,
    reviewer: 'octocat',
    body: 'rename foo',
    now: new Date('2026-06-04T00:00:00Z'),
    ...overrides,
  });
}

function makeDeps(overrides: Partial<PollTaskRunnerDeps> = {}): {
  deps: PollTaskRunnerDeps;
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
  git.remoteRefs.set('origin/feat-x', 'abc123');
  git.headByCwd.set('/work/tree', 'abc123');

  let replyCounter = 0;
  const deps: PollTaskRunnerDeps = {
    github,
    git,
    agent,
    prReviewRepo: repo,
    renderTaskPrompt: async () => '/tmp/prompt.md',
    extractTaskResult: async () => ({
      ok: true,
      result: { commentId: 9001, action: 'fixed', replyBody: 'Renamed foo to bar.' },
    }),
    verifyCommitPushed: async () => true,
    verifyBuildPasses: async () => true,
    resolveProfileForPhase: () => 'post-pr-review-profile' as never,
    idFactory: () => `id-${++replyCounter}`,
    now: () => new Date('2026-06-04T00:10:00Z'),
    ...overrides,
  };
  return { deps, github, git, repo, agent };
}

function makeInput(overrides: Partial<PollTaskInput> = {}): PollTaskInput {
  return {
    runId,
    repoId,
    repoFullName: 'o/r',
    prNumber: 5,
    cwd: '/work/tree',
    phaseId,
    pollNumber: 1,
    comment: makeComment(),
    diff: '--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-old\n+new',
    branch: 'feat-x',
    startCommitSha: 'abc123',
    ...overrides,
  };
}

describe('PollTaskRunner — happy path', () => {
  it('processes a fixed comment: invokes agent, posts reply, verifies, marks processed', async () => {
    const { deps, github, git } = makeDeps();
    // Simulate agent creating a new commit
    git.headByCwd.set('/work/tree', 'def456');
    const runner = new PollTaskRunner(deps);

    const out = await runner.execute(makeInput());

    expect(out).toEqual({
      commentId: 9001,
      action: 'fixed',
      processed: true,
      blocked: false,
    });
    expect(github.repliesPosted).toHaveLength(1);
    expect(github.resolvedThreads).toEqual(
      expect.arrayContaining([expect.objectContaining({ commentId: 9001 })]),
    );
  });

  it('processes a no_fix comment', async () => {
    const { deps, github } = makeDeps({
      extractTaskResult: async () => ({
        ok: true,
        result: { commentId: 9001, action: 'no_fix', replyBody: 'Comment is invalid.' },
      }),
    });
    const runner = new PollTaskRunner(deps);

    const out = await runner.execute(makeInput());

    expect(out.action).toBe('no_fix');
    expect(out.processed).toBe(true);
    expect(github.repliesPosted).toHaveLength(1);
  });

  it('processes a blocked comment', async () => {
    const { deps, repo } = makeDeps({
      extractTaskResult: async () => ({
        ok: true,
        result: {
          commentId: 9001,
          action: 'blocked',
          replyBody: 'Cannot fix.',
          blockedReason: 'out of scope',
        },
      }),
    });
    const runner = new PollTaskRunner(deps);

    const out = await runner.execute(makeInput());

    expect(out.action).toBe('blocked');
    expect(out.blocked).toBe(true);
    const comment = repo.getComment(runId, 9001);
    expect(comment?.state).toBe('blocked');
  });
});

describe('PollTaskRunner — failure isolation', () => {
  it('returns failed when agent invocation fails', async () => {
    const { deps, agent } = makeDeps();
    agent.clearQueue('post-pr-review-profile');
    agent.enqueue('post-pr-review-profile', makeSuccessAgentResult({ outcome: 'error' }));

    const runner = new PollTaskRunner(deps);
    const out = await runner.execute(makeInput());

    expect(out.action).toBe('failed');
    expect(out.processed).toBe(false);
  });

  it('returns failed when result extraction fails', async () => {
    const { deps } = makeDeps({
      extractTaskResult: async () => ({ ok: false, reason: 'missing', detail: 'no file' }),
    });
    const runner = new PollTaskRunner(deps);

    const out = await runner.execute(makeInput());

    expect(out.action).toBe('failed');
    expect(out.processed).toBe(false);
  });
});
