import { describe, it, expect } from 'vitest';
import { RunId, RepositoryId, PhaseName, createPrReviewComment } from '@ai-sdlc/domain';
import type { PrReviewComment, PrReviewReply } from '@ai-sdlc/domain';
import {
  FakeGitHubPort,
  FakeGitPort,
  FakePrReviewRepository,
  FakeAgentPort,
  FakeArtifactStore,
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

class RecordingPrReviewRepository extends FakePrReviewRepository {
  operations: string[] = [];

  override upsertComment(comment: PrReviewComment): void {
    this.operations.push(`upsertComment:${comment.state}:${comment.commentId}`);
    super.upsertComment(comment);
  }

  override insertReply(reply: PrReviewReply): void {
    this.operations.push(`insertReply:${reply.commentId}`);
    super.insertReply(reply);
  }
}

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
  repo: RecordingPrReviewRepository;
  agent: FakeAgentPort;
} {
  const github = new FakeGitHubPort();
  const git = new FakeGitPort();
  const repo = new RecordingPrReviewRepository();
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
  git.ancestorResults.set('abc123|abc123', true);
  git.logBetweenResults.set('abc123|abc123', ['abc123']);

  let replyCounter = 0;
  const artifactStore = new FakeArtifactStore();
  const deps: PollTaskRunnerDeps = {
    github,
    git,
    agent,
    prReviewRepo: repo,
    artifactStore,
    renderTaskPrompt: async () => '/tmp/prompt.md',
    extractTaskResult: async () => ({
      ok: true,
      result: { commentId: 9001, action: 'fixed', replyBody: 'Renamed foo to bar.' },
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
    comment: makeComment(),
    diff: '--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-old\n+new',
    branch: 'feat-x',
    startCommitSha: 'abc123',
    unresolvedCommentCount: 1,
    ...overrides,
  };
}

describe('PollTaskRunner — reply attempt ordering regression tests', () => {
  it('reply attempt ordering regression: no_fix', async () => {
    const { deps, repo } = makeDeps({
      extractTaskResult: async () => ({
        ok: true,
        result: { commentId: 9001, action: 'no_fix', replyBody: 'Comment is invalid.' },
      }),
    });
    const runner = new PollTaskRunner(deps);

    const out = await runner.execute(makeInput());
    expect(out.processed).toBe(true);

    const insertIdx = repo.operations.indexOf('insertReply:9001');
    const firstRepliedIdx = repo.operations.indexOf('upsertComment:replied:9001');

    expect(insertIdx).not.toBe(-1);
    expect(firstRepliedIdx).not.toBe(-1);
    expect(insertIdx).toBeLessThan(firstRepliedIdx);
  });

  it('reply attempt ordering regression: fixed', async () => {
    const { deps, repo, git, agent } = makeDeps();
    agent.clearQueue('post-pr-review-profile');
    agent.enqueue('post-pr-review-profile', () => {
      git.headByCwd.set('/work/tree', 'def456');
      return makeSuccessAgentResult();
    });
    // Simulate agent creating a new commit
    git.remoteRefs.set('origin/feat-x', 'def456');
    git.ancestorResults.set('def456|def456', true);
    git.logBetweenResults.set('abc123|def456', ['def456']);
    const runner = new PollTaskRunner(deps);

    const out = await runner.execute(makeInput());
    expect(out.processed).toBe(true);

    const insertIdx = repo.operations.indexOf('insertReply:9001');
    const firstRepliedIdx = repo.operations.indexOf('upsertComment:replied:9001');

    expect(insertIdx).not.toBe(-1);
    expect(firstRepliedIdx).not.toBe(-1);
    expect(insertIdx).toBeLessThan(firstRepliedIdx);

    const comment = repo.getComment(runId, 9001);
    expect(typeof comment?.replyId).toBe('number');
  });
});
