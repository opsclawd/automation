import { describe, it, expect } from 'vitest';
import { RunId, RepositoryId, PhaseName } from '@ai-sdlc/domain';
import {
  FakeAgentPort,
  FakeGitHubPort,
  FakeGitPort,
  FakePrReviewRepository,
} from '../../test-doubles/index.js';
import type { AgentInvocationResult } from '../../ports/agent-invocation-types.js';
import {
  ProcessPrReviewComments,
  type ProcessPrReviewDeps,
} from '../process-pr-review-comments.js';

const runId = RunId('44444444-4444-4444-4444-444444444444');
const repoId = RepositoryId('o/r');

function makeSuccess(overrides: Partial<AgentInvocationResult> = {}): AgentInvocationResult {
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
} {
  const github = new FakeGitHubPort();
  const git = new IncrementingShaGitPort();
  const repo = new FakePrReviewRepository();
  const agent = new FakeAgentPort({
    'post-pr-review-profile': [makeSuccess(), makeSuccess(), makeSuccess()],
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
      createdAt: new Date(),
    },
  ]);
  git.remoteRefs.set('origin/feat-x', 'tipSha');

  let replyCounter = 0;
  const deps: ProcessPrReviewDeps = {
    github,
    git,
    agent,
    prReviewRepo: repo,
    renderTaskPrompt: async () => {
      return '/tmp/prompt.md';
    },
    extractTaskResult: async () => ({
      ok: true,
      result: { "9001": { action: 'fixed', replyBody: 'Renamed.' } },
    }),
    verifyCommitPushed: async () => true,
    verifyBuildPasses: async () => ({ passed: true }),
    resolveProfileForPhase: () => 'post-pr-review-profile' as never,
    idFactory: () => `id-${++replyCounter}`,
    now: () => new Date('2026-06-04T00:10:00Z'),
    ...overrides,
  };
  return { deps, github, git, repo };
}

describe('ProcessPrReviewComments — final attempt verification (M1 progression)', () => {
  it('marks comment processed on attempt 3 if the final manual verify pass succeeds', async () => {
    // Scenario:
    // Attempt 1: Agent commits sha-2, build fails.
    // Attempt 2: Agent commits sha-4 (on top of sha-2), build fails.
    // Attempt 3: Agent commits sha-6 (on top of sha-4), agent returns action=fixed.
    //            Orchestrator normally verifyBuildPasses(sha-6) but we mock it failing.
    //            The loop exhausts ESCALATION_BUDGET (3).
    //            A FINAL verifyComment(replied, d, { runningStartSha: sha-6 }) is called.
    //            If that pass returns ok: true, the comment is marked processed.
    const { deps, repo, github } = makeDeps({
      verifyBuildPasses: async () => ({ passed: false }), // build always fails for the runner
    });

    const uc = new ProcessPrReviewComments(deps);

    // Manual intervention: make the FINAL verify pass (called outside the attempt loop) succeed.
    // The runner calls verifyComment on attempt 3 exhaustion.
    // verifyComment needs: replyVerified, commitVerified, buildVerified, codeVerified.
    // We override verifyBuildPasses to fail above, so we must satisfy the verifier's
    // independent verifyBuildPasses call.
    let callCount = 0;
    deps.verifyBuildPasses = async () => {
      callCount++;
      // Attempts 1, 2, 3 fail.
      // verifyComment (triggered on attempt 3 exhaustion) also calls it.
      return { passed: callCount > 3 };
    };

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
    const comment = repo.getComment(runId, 9001);
    expect(comment?.state).toBe('processed');
    expect(github.resolvedThreads).toContainEqual({
      repoFullName: 'o/r',
      prNumber: 5,
      commentId: 9001,
    });
  });

  it('blocks comment on attempt 3 if the final manual verify pass also fails', async () => {
    const { deps, repo } = makeDeps({
      verifyBuildPasses: async () => ({ passed: false }),
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

    expect(out.processed).toBe(0);
    expect(out.blocked).toBe(1);
    const comment = repo.getComment(runId, 9001);
    expect(comment?.state).toBe('blocked');
    expect(comment?.blockedReason).toContain('task failed after 3 attempts');
  });

  it('uses runningStartSha (M1) when the final verify pass occurs after SHA progression', async () => {
    // Scenario: Two comments. Task 1 fixes (sha-2) and passes.
    // Task 2 attempts 1, 2 fail (sha-4, sha-6).
    // Attempt 3 for Task 2 also fails the build (sha-8).
    // The final verifyComment call for Task 2 must anchor to sha-6 (the start of task 2 attempt 3),
    // NOT sha-1 (poll start).
    const github = new FakeGitHubPort();
    const git = new IncrementingShaGitPort();
    const repo = new FakePrReviewRepository();

    github.prs.set('o/r/5', {
      number: 5,
      url: 'x',
      state: 'open',
      headRefName: 'feat-x',
    });
    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'a.ts',
        line: 1,
        reviewer: 'a',
        body: 'fix row 1',
        createdAt: new Date(),
      },
      {
        id: 9002,
        prNumber: 5,
        path: 'shifts.ts',
        line: 100,
        reviewer: 'b',
        body: 'fix row 100',
        createdAt: new Date(),
      },
    ]);
    git.remoteRefs.set('origin/feat-x', 'tipSha');

    let replyCounter = 0;
    const deps: ProcessPrReviewDeps = {
      github,
      git,
      agent: new FakeAgentPort({
        'post-pr-review-profile': [makeSuccess(), makeSuccess(), makeSuccess(), makeSuccess()],
      }),
      prReviewRepo: repo,
      renderTaskPrompt: async () => {
        return '/tmp/p.md';
      },
      extractTaskResult: async () => ({
        ok: true,
        result: { "9001": { action: 'fixed', replyBody: 'fixed' }, "9002": { action: 'fixed', replyBody: 'fixed' } },
      }),
      verifyCommitPushed: async () => true,
      verifyBuildPasses: async () => ({ passed: true }),
      resolveProfileForPhase: () => 'post-pr-review-profile' as never,
      idFactory: () => `id-${++replyCounter}`,
      now: () => new Date('2026-06-04T00:10:00Z'),
    };

    // Task 1 succeeds. Task 2 fails its first 2 runner passes then we exhaust budget.
    let buildCount = 0;
    deps.verifyBuildPasses = async () => {
      buildCount++;
      // runner.execute calls buildPasses once per attempt.
      // Task 1: call 1 (pass)
      // Task 2: call 2 (fail), 3 (fail), 4 (fail)
      // Final verify pass for Task 2 (triggered on budget exhaustion): call 5.
      if (buildCount === 1) return { passed: true };
      if (buildCount <= 4) return { passed: false };
      return { passed: true }; // Final verify pass succeeds
    };

    const uc = new ProcessPrReviewComments(deps);
    const result = await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 1,
    });

    expect(result.processed).toBe(2);
    expect(repo.getComment(runId, 9002)?.state).toBe('processed');
  });
});
