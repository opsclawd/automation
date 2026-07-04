import { describe, it, expect } from 'vitest';
import { RunId, RepositoryId, PhaseName } from '@ai-sdlc/domain';
import {
  FakeAgentPort,
  FakeGitHubPort,
  FakeGitPort,
  FakeFixDiffInspector,
  FakePrReviewRepository,
  makeFixDiffInspector,
} from '../../test-doubles/index.js';
import type { AgentInvocationResult } from '../../ports/agent-invocation-types.js';
import type { VerifyCodeChangeFn } from '../verify-code-change.js';
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
  let currentCommentId = 9001;
  const deps: ProcessPrReviewDeps = {
    github,
    git,
    agent,
    prReviewRepo: repo,
    renderTaskPrompt: async ({ comment }) => {
      currentCommentId = comment.commentId;
      return '/tmp/prompt.md';
    },
    extractTaskResult: async () => ({
      ok: true,
      result: { commentId: currentCommentId, action: 'fixed', replyBody: 'Renamed.' },
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

const baseInput = {
  runId,
  repoId,
  repoFullName: 'o/r',
  prNumber: 5,
  cwd: '/work',
  phaseId: PhaseName('post-pr-review'),
  pollNumber: 1,
};

describe('ProcessPrReviewComments — final-attempt verification', () => {
  it('resolves when verifier returns ok on the final attempt', async () => {
    const { deps, github, repo } = makeDeps();
    const inspector = new FakeFixDiffInspector();
    inspector.setNext({ touchesPath: true, nearLine: true, reason: '' });
    const uc = new ProcessPrReviewComments({
      ...deps,
      fixDiffInspector: makeFixDiffInspector(inspector),
    });

    const out = await uc.execute(baseInput);

    expect(out.processed).toBe(1);
    expect(out.blocked).toBe(0);
    expect(github.repliesPosted).toHaveLength(1);
    expect(repo.getComment(runId, 9001)?.state).toBe('processed');
  });

  it('blocks with "code verified correct but build failing" when verifier says code ok but build red', async () => {
    let buildCallCount = 0;
    const { deps, repo } = makeDeps({
      verifyBuildPasses: async () => {
        buildCallCount++;
        if (buildCallCount === 3) {
          return { passed: true };
        }
        return { passed: false, error: 'TS2722: type mismatch' };
      },
    });
    const inspector = new FakeFixDiffInspector();
    inspector.setNext({ touchesPath: true, nearLine: true, reason: '' });
    const uc = new ProcessPrReviewComments({
      ...deps,
      fixDiffInspector: makeFixDiffInspector(inspector),
    });

    const out = await uc.execute(baseInput);

    expect(out.processed).toBe(0);
    expect(out.blocked).toBe(1);
    expect(repo.getComment(runId, 9001)?.state).toBe('blocked');
    expect(repo.getComment(runId, 9001)?.blockedReason).toMatch(
      /code verified correct but build failing/,
    );
    expect(repo.getComment(runId, 9001)?.blockedReason).toContain('TS2722');
  });

  it('blocks with "verified incorrect" when verifier says codeVerified:false', async () => {
    let codeVerifyCallCount = 0;
    const { deps, repo } = makeDeps({
      verifyCodeChange: (async () => {
        codeVerifyCallCount++;
        if (codeVerifyCallCount === 3) {
          return { pass: true, reason: 'ok' };
        }
        return { pass: false, reason: 'variable still mutable' };
      }) as VerifyCodeChangeFn,
    });
    const inspector = new FakeFixDiffInspector();
    inspector.setNext({ touchesPath: true, nearLine: true, reason: '' });
    const uc = new ProcessPrReviewComments({
      ...deps,
      fixDiffInspector: makeFixDiffInspector(inspector),
    });

    const out = await uc.execute(baseInput);

    expect(out.blocked).toBe(1);
    expect(repo.getComment(runId, 9001)?.blockedReason).toMatch(/verified incorrect/);
    expect(repo.getComment(runId, 9001)?.blockedReason).toContain('variable still mutable');
  });

  it('blocks with "fix commit does not touch" reason from the structural pre-check', async () => {
    const { deps, repo } = makeDeps();
    const inspector = new FakeFixDiffInspector();
    inspector.setNext({
      touchesPath: false,
      nearLine: 'skipped',
      reason: 'fix commit abcdef0 does not touch a.ts',
    });
    const uc = new ProcessPrReviewComments({
      ...deps,
      fixDiffInspector: makeFixDiffInspector(inspector),
    });

    const out = await uc.execute(baseInput);

    expect(out.blocked).toBe(1);
    expect(repo.getComment(runId, 9001)?.blockedReason).toMatch(/does not touch a\.ts/);
  });

  it('does NOT call rollbackFix when the final attempt is verified (build path included)', async () => {
    const rollbackCalls: unknown[] = [];
    const { deps } = makeDeps({
      rollbackFix: async (ctx, sha) => {
        rollbackCalls.push({ ctx, sha });
        return true;
      },
    });
    const inspector = new FakeFixDiffInspector();
    inspector.setNext({ touchesPath: true, nearLine: true, reason: '' });
    const uc = new ProcessPrReviewComments({
      ...deps,
      fixDiffInspector: makeFixDiffInspector(inspector),
    });

    const out = await uc.execute(baseInput);
    expect(out.processed).toBe(1);
    expect(rollbackCalls).toHaveLength(0);
  });

  it('preserves the generic "task failed after N attempts" when the agent invocation threw (no verifier run possible)', async () => {
    const { deps, repo } = makeDeps();
    const agent = new FakeAgentPort({
      'post-pr-review-profile': [
        { ...makeSuccess(), outcome: 'failed', exitCode: 1 },
        { ...makeSuccess(), outcome: 'failed', exitCode: 1 },
        { ...makeSuccess(), outcome: 'failed', exitCode: 1 },
      ],
    });
    const inspector = new FakeFixDiffInspector();
    inspector.setNext({ touchesPath: true, nearLine: true, reason: '' });
    const uc = new ProcessPrReviewComments({
      ...deps,
      agent,
      fixDiffInspector: makeFixDiffInspector(inspector),
    });

    const out = await uc.execute(baseInput);

    expect(out.blocked).toBe(1);
    expect(repo.getComment(runId, 9001)?.blockedReason).toMatch(/task failed after 3 attempts/);
  });
});

describe('ProcessPrReviewComments — multi-comment line-shift', () => {
  function multiCommentDeps(): {
    deps: ProcessPrReviewDeps;
    github: FakeGitHubPort;
    git: FakeGitPort;
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
        path: 'shifts.ts',
        line: 4,
        reviewer: 'a',
        body: 'fix row 4',
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
    let currentCommentId = 9001;
    const deps: ProcessPrReviewDeps = {
      github,
      git,
      agent,
      prReviewRepo: repo,
      renderTaskPrompt: async ({ comment }) => {
        currentCommentId = comment.commentId;
        return '/tmp/p.md';
      },
      extractTaskResult: async () => ({
        ok: true,
        result: { commentId: currentCommentId, action: 'fixed', replyBody: 'fixed' },
      }),
      verifyCommitPushed: async () => true,
      verifyBuildPasses: async () => ({ passed: true }),
      resolveProfileForPhase: () => 'post-pr-review-profile' as never,
      idFactory: () => `id-${++replyCounter}`,
      now: () => new Date('2026-06-04T00:10:00Z'),
    };
    return { deps, github, git };
  }

  it('translates a stale comment line through the structural shift when there is one comment', async () => {
    const { deps, github } = multiCommentDeps();
    github.comments.set('o/r/5', [
      {
        id: 9001,
        prNumber: 5,
        path: 'shifts.ts',
        line: 4,
        reviewer: 'a',
        body: 'fix row 4',
        createdAt: new Date(),
      },
    ]);
    const inspector = new FakeFixDiffInspector();
    let captured: { originalStartCommitSha: string; runningStartSha: string } | undefined;
    inspector.setResultFn((input) => {
      captured = {
        originalStartCommitSha: input.originalStartCommitSha,
        runningStartSha: input.runningStartSha,
      };
      return { touchesPath: true, nearLine: 'skipped', reason: 'ambiguous' };
    });
    const uc = new ProcessPrReviewComments({
      ...deps,
      fixDiffInspector: makeFixDiffInspector(inspector),
    });

    await uc.execute(baseInput);
    expect(captured).toBeDefined();
    expect(captured!.originalStartCommitSha).toBe(captured!.runningStartSha);
  });

  it('passes the poll-start SHA and the runningStartSha into the inspector across two comments', async () => {
    const { deps, git } = multiCommentDeps();
    // Override runningStartSha so the comment-to-comment translation path is exercised.
    const originalHeadCommit = git.headCommitSha.bind(git);
    const shas = [
      'poll-start-sha',
      'poll-start-sha',
      'after-first-fix-sha',
      'after-first-fix-sha',
      'after-second-fix-sha',
    ];
    let shaIdx = 0;
    git.headCommitSha = async () => {
      const v = shas[Math.min(shaIdx, shas.length - 1)] ?? originalHeadCommit('/work');
      shaIdx++;
      return v;
    };
    const inspector = new FakeFixDiffInspector();
    const seen: Array<{ original: string; running: string }> = [];
    inspector.setResultFn((input) => {
      seen.push({ original: input.originalStartCommitSha, running: input.runningStartSha });
      return { touchesPath: true, nearLine: 'skipped', reason: 'ambiguous' };
    });
    const uc = new ProcessPrReviewComments({
      ...deps,
      fixDiffInspector: makeFixDiffInspector(inspector),
    });

    await uc.execute(baseInput);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    // Both observations should share `original === poll-start-sha` (the
    // originalStartCommitSha is invariant for the whole poll), but
    // `running` may differ across tasks.
    for (const s of seen) {
      expect(s.original).toBe('poll-start-sha');
    }
  });
});
