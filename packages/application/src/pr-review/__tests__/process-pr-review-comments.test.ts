import { describe, it, expect } from 'vitest';
import { RunId, RepositoryId, PhaseName, } from '@ai-sdlc/domain';
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

class IncrementingShaGitPort extends FakeGitPort {
  private n = 0;
  override async headCommitSha(_cwd: string): Promise<string> {
    return `sha-${++this.n}`;
  }
  override async isAncestor(): Promise<boolean> {
    return true;
  }
  override async logBetween(): Promise<string[]> {
    return ['dummy'];
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
  let currentCommentIds: number[] = [];
  const deps: ProcessPrReviewDeps = {
    github,
    git,
    agent,
    prReviewRepo: repo,
    renderTaskPrompt: async ({ comments }) => {
      currentCommentIds = comments.map((c) => c.commentId);
      return '/tmp/prompt.md';
    },
    extractTaskResult: async () => {
      const result: Record<string, { action: "fixed" | "no_fix" | "blocked"; replyBody: string; blockedReason?: string }> = {};
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

    const poll = repo.latestPollAttempt(runId);
    expect(poll?.terminalState).toBe('all_resolved');
  });
});
