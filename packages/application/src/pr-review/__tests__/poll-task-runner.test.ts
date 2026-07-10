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
      result: { "9001": { action: 'fixed', replyBody: 'Renamed foo to bar.' } },
    }),
    verifyCommitPushed: async () => true,
    verifyBuildPasses: async () => ({ passed: true }),
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
    attempt: 1,
    comments: [makeComment()],
    diff: '--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-old\n+new',
    branch: 'feat-x',
    startCommitSha: 'abc123',
    originalStartCommitSha: 'abc123',
    unresolvedCommentCount: 1,
    ...overrides,
  };
}

describe('PollTaskRunner — happy path', () => {
  it('processes a fixed comment: invokes agent, posts reply, verifies, marks processed', async () => {
    const { deps, github, git, agent } = makeDeps();
    agent.clearQueue('post-pr-review-profile');
    agent.enqueue('post-pr-review-profile', () => {
      git.headByCwd.set('/work/tree', 'def456');
      return makeSuccessAgentResult();
    });
    git.remoteRefs.set('origin/feat-x', 'def456');
    git.ancestorResults.set('def456|def456', true);
    git.logBetweenResults.set('abc123|def456', ['def456']);
    const runner = new PollTaskRunner(deps);

    const out = await runner.execute(makeInput());

    expect(out.comments[0]).toEqual({
      commentId: 9001,
      action: 'fixed',
      processed: true,
      blocked: false,
    });
    expect(git.pushes).toHaveLength(1);
  });
});
