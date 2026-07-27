import { describe, it, expect } from 'vitest';
import { RunId, RepositoryId, PhaseName, createPrReviewComment } from '@ai-sdlc/domain';
import type { PollTaskBatchResultEntry } from '../../results/schemas/poll-task-result.js';
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
  type PollBatchTaskInput,
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

function makeComment(
  commentId: number,
  overrides: Partial<ReturnType<typeof createPrReviewComment>> = {},
) {
  return createPrReviewComment({
    runId,
    prNumber: 5,
    commentId,
    path: 'a.ts',
    line: 3,
    reviewer: 'octocat',
    body: `rename foo for ${commentId}`,
    now: new Date('2026-06-04T00:00:00Z'),
    ...overrides,
  });
}

interface BatchTestDeps {
  deps: PollTaskRunnerDeps;
  github: FakeGitHubPort;
  git: FakeGitPort;
  repo: FakePrReviewRepository;
  agent: FakeAgentPort;
}

function makeBatchDeps(
  batchExtractResult?: (input: {
    resultJsonPath?: string;
    cwd: string;
  }) => Promise<
    { ok: true; result: PollTaskBatchResultEntry[] } | { ok: false; reason: string; detail: string }
  >,
  overrides: Partial<PollTaskRunnerDeps> = {},
): BatchTestDeps {
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
    {
      id: 9002,
      prNumber: 5,
      path: 'a.ts',
      line: 5,
      reviewer: 'octocat',
      body: 'rename bar',
      createdAt: new Date('2026-06-04T00:00:00Z'),
    },
    {
      id: 9003,
      prNumber: 5,
      path: 'b.ts',
      line: 10,
      reviewer: 'octocat',
      body: 'rename baz',
      createdAt: new Date('2026-06-04T00:00:00Z'),
    },
  ]);
  git.remoteRefs.set('origin/feat-x', 'abc123');
  git.headByCwd.set('/work/tree', 'abc123');
  git.ancestorResults.set('abc123|abc123', true);
  git.logBetweenResults.set('abc123|abc123', ['abc123']);

  let replyCounter = 0;
  const artifactStore = new FakeArtifactStore();
  const defaultExtractBatchTaskResult = async (): Promise<
    { ok: true; result: PollTaskBatchResultEntry[] } | { ok: false; reason: string; detail: string }
  > => ({
    ok: true,
    result: [{ commentId: 9001, action: 'fixed', replyBody: 'Renamed foo to bar.' }],
  });

  const deps: PollTaskRunnerDeps = {
    github,
    git,
    agent,
    prReviewRepo: repo,
    artifactStore,
    renderTaskPrompt: async () => '/tmp/prompt.md',
    renderBatchTaskPrompt: async () => '/tmp/batch-prompt.md',
    extractTaskResult: async () => ({
      ok: true,
      result: { commentId: 9001, action: 'fixed', replyBody: 'Renamed foo to bar.' },
    }),
    extractBatchTaskResult: batchExtractResult ?? defaultExtractBatchTaskResult,
    verifyCommitPushed: async () => true,
    verifyBuildPasses: async () => ({ passed: true }),
    resolveProfileForPhase: () => 'post-pr-review-profile' as never,
    idFactory: () => `id-${++replyCounter}`,
    now: () => new Date('2026-06-04T00:10:00Z'),
    ...overrides,
  };
  return { deps, github, git, repo, agent };
}

function makeBatchInput(
  comments: ReturnType<typeof makeComment>[],
  overrides: Partial<PollBatchTaskInput> = {},
): PollBatchTaskInput {
  return {
    runId,
    repoId,
    repoFullName: 'o/r',
    prNumber: 5,
    cwd: '/work/tree',
    phaseId,
    pollNumber: 1,
    comments,
    diff: '--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-old\n+new',
    branch: 'feat-x',
    startCommitSha: 'abc123',
    originalStartCommitSha: 'abc123',
    unresolvedCommentCount: comments.length,
    reviewMode: 'initial_full',
    retryNumber: 1,
    ...overrides,
  };
}

describe('PollTaskRunner batch — contract tests', () => {
  describe('one batch creates one agent invocation and one attempt record per comment', () => {
    it('invokes agent exactly once for a batch of comments', async () => {
      const { deps, agent } = makeBatchDeps();
      const comments = [makeComment(9001), makeComment(9002)];
      const runner = new PollTaskRunner(deps);

      await runner.executeBatch(makeBatchInput(comments));

      expect(agent.invocations).toHaveLength(1);
    });

    it('creates one attempt record per comment with distinct attempt IDs', async () => {
      const { deps, repo, agent, git } = makeBatchDeps(async () => ({
        ok: true,
        result: [
          { commentId: 9001, action: 'fixed', replyBody: 'Fixed 1' },
          { commentId: 9002, action: 'fixed', replyBody: 'Fixed 2' },
        ],
      }));
      agent.clearQueue('post-pr-review-profile');
      agent.enqueue('post-pr-review-profile', () => {
        git.headByCwd.set('/work/tree', 'def456');
        return makeSuccessAgentResult();
      });
      git.remoteRefs.set('origin/feat-x', 'def456');
      git.ancestorResults.set('def456|def456', true);
      git.logBetweenResults.set('abc123|def456', ['def456']);

      const comments = [makeComment(9001), makeComment(9002)];
      const runner = new PollTaskRunner(deps);

      await runner.executeBatch(makeBatchInput(comments));

      const attempts = repo.listCommentAttempts(runId, 9001);
      expect(attempts).toHaveLength(1);
      const attempt1 = attempts[0];

      const attempts2 = repo.listCommentAttempts(runId, 9002);
      expect(attempts2).toHaveLength(1);
      const attempt2 = attempts2[0];

      expect(attempt1.attemptId).not.toBe(attempt2.attemptId);
      expect(attempt1.promptPath).toBe(attempt2.promptPath);
      expect(attempt1.resultArtifactPath).toBe(attempt2.resultArtifactPath);
    });

    it('sets batch ID and comment count in agent invocation metadata', async () => {
      const { deps, agent } = makeBatchDeps();
      const comments = [makeComment(9001), makeComment(9002), makeComment(9003)];
      const runner = new PollTaskRunner(deps);

      await runner.executeBatch(makeBatchInput(comments));

      expect(agent.invocations[0].metadata).toMatchObject({
        pr_review_batch_id: expect.any(String),
        pr_review_comment_ids: [9001, 9002, 9003],
        pr_review_comment_count: 3,
      });
    });
  });

  describe('malformed exact-id output resets the batch and posts no replies', () => {
    it('missing comment ID causes reset with no external effects', async () => {
      const { deps, github, git, agent } = makeBatchDeps(async () => ({
        ok: true,
        result: [{ commentId: 9001, action: 'fixed', replyBody: 'Fixed 1' }],
      }));
      agent.clearQueue('post-pr-review-profile');
      agent.enqueue('post-pr-review-profile', () => {
        git.headByCwd.set('/work/tree', 'def456');
        return makeSuccessAgentResult();
      });

      const comments = [makeComment(9001), makeComment(9002)];
      const runner = new PollTaskRunner(deps);

      const result = await runner.executeBatch(makeBatchInput(comments));

      expect(result.retryDisposition).toBe('split');
      expect(github.repliesPosted).toHaveLength(0);
      expect(git.pushes).toHaveLength(0);
      expect(git.headByCwd.get('/work/tree')).toBe('abc123');
    });

    it('duplicate comment ID causes reset with no external effects', async () => {
      const { deps, github, git, agent } = makeBatchDeps(async () => ({
        ok: true,
        result: [
          { commentId: 9001, action: 'fixed', replyBody: 'Fixed 1' },
          { commentId: 9001, action: 'fixed', replyBody: 'Fixed 1 dup' },
        ],
      }));
      agent.clearQueue('post-pr-review-profile');
      agent.enqueue('post-pr-review-profile', () => {
        git.headByCwd.set('/work/tree', 'def456');
        return makeSuccessAgentResult();
      });

      const comments = [makeComment(9001), makeComment(9002)];
      const runner = new PollTaskRunner(deps);

      const result = await runner.executeBatch(makeBatchInput(comments));

      expect(result.retryDisposition).toBe('split');
      expect(github.repliesPosted).toHaveLength(0);
      expect(git.pushes).toHaveLength(0);
    });

    it('unknown comment ID causes reset with no external effects', async () => {
      const { deps, github, git, agent } = makeBatchDeps(async () => ({
        ok: true,
        result: [
          { commentId: 9001, action: 'fixed', replyBody: 'Fixed 1' },
          { commentId: 9002, action: 'fixed', replyBody: 'Fixed 2' },
          { commentId: 9999, action: 'fixed', replyBody: 'Unknown' },
        ],
      }));
      agent.clearQueue('post-pr-review-profile');
      agent.enqueue('post-pr-review-profile', () => {
        git.headByCwd.set('/work/tree', 'def456');
        return makeSuccessAgentResult();
      });

      const comments = [makeComment(9001), makeComment(9002)];
      const runner = new PollTaskRunner(deps);

      const result = await runner.executeBatch(makeBatchInput(comments));

      expect(result.retryDisposition).toBe('split');
      expect(github.repliesPosted).toHaveLength(0);
      expect(git.pushes).toHaveLength(0);
    });

    it('malformed JSON output returns failure without external effects', async () => {
      const { deps, github, git, agent } = makeBatchDeps(async () => ({
        ok: false,
        reason: 'parse_error',
        detail: 'Invalid JSON',
      }));
      agent.clearQueue('post-pr-review-profile');
      agent.enqueue('post-pr-review-profile', () => {
        git.headByCwd.set('/work/tree', 'def456');
        return makeSuccessAgentResult();
      });

      const comments = [makeComment(9001), makeComment(9002)];
      const runner = new PollTaskRunner(deps);

      const result = await runner.executeBatch(makeBatchInput(comments));

      expect(result.retryDisposition).toBe('split');
      expect(github.repliesPosted).toHaveLength(0);
      expect(git.pushes).toHaveLength(0);
    });
  });

  describe('one fixed-comment verifier rejection rolls back every fixed change and splits the batch', () => {
    it('verifier failure for one fixed comment rolls back all and splits', async () => {
      const { deps, github, git, repo, agent } = makeBatchDeps(
        async () => ({
          ok: true,
          result: [
            { commentId: 9001, action: 'fixed', replyBody: 'Fixed 1' },
            { commentId: 9002, action: 'no_fix', replyBody: 'No fix needed' },
          ],
        }),
        {
          verifyCodeChange: async () => ({ pass: false, reason: 'unwanted change' }),
        },
      );
      agent.clearQueue('post-pr-review-profile');
      agent.enqueue('post-pr-review-profile', () => {
        git.headByCwd.set('/work/tree', 'def456');
        return makeSuccessAgentResult();
      });
      git.remoteRefs.set('origin/feat-x', 'def456');
      git.ancestorResults.set('def456|def456', true);
      git.logBetweenResults.set('abc123|def456', ['def456']);

      const comments = [makeComment(9001), makeComment(9002)];
      const runner = new PollTaskRunner(deps);

      const result = await runner.executeBatch(makeBatchInput(comments));

      expect(result.retryDisposition).toBe('split');
      expect(git.pushes).toHaveLength(0);
      expect(github.repliesPosted).toHaveLength(0);
      expect(git.headByCwd.get('/work/tree')).toBe('abc123');

      const attempts1 = repo.listCommentAttempts(runId, 9001);
      expect(attempts1[0].disposition).toBe('failure');
      expect(attempts1[0].verifierFeedback).toBe('unwanted change');
    });
  });

  describe('one build failure records feedback for every batch member and resets once', () => {
    it('build failure attaches feedback to all attempts and resets once', async () => {
      const { deps, git, repo, agent } = makeBatchDeps(
        async () => ({
          ok: true,
          result: [
            { commentId: 9001, action: 'fixed', replyBody: 'Fixed 1' },
            { commentId: 9002, action: 'fixed', replyBody: 'Fixed 2' },
            { commentId: 9003, action: 'fixed', replyBody: 'Fixed 3' },
          ],
        }),
        {
          verifyBuildPasses: async () => ({ passed: false, error: 'tsc failed: TS2322' }),
        },
      );
      agent.clearQueue('post-pr-review-profile');
      agent.enqueue('post-pr-review-profile', () => {
        git.headByCwd.set('/work/tree', 'def456');
        return makeSuccessAgentResult();
      });

      const comments = [makeComment(9001), makeComment(9002), makeComment(9003)];
      const runner = new PollTaskRunner(deps);

      const result = await runner.executeBatch(makeBatchInput(comments));

      expect(result.retryDisposition).toBe('split');
      expect(git.pushes).toHaveLength(0);
      expect(git.headByCwd.get('/work/tree')).toBe('abc123');

      const attempts1 = repo.listCommentAttempts(runId, 9001);
      const attempts2 = repo.listCommentAttempts(runId, 9002);
      const attempts3 = repo.listCommentAttempts(runId, 9003);

      expect(attempts1[0].buildFeedback).toBe('tsc failed: TS2322');
      expect(attempts2[0].buildFeedback).toBe('tsc failed: TS2322');
      expect(attempts3[0].buildFeedback).toBe('tsc failed: TS2322');
    });
  });

  describe('a valid mixed fixed no-fix blocked batch keeps per-comment outcomes independent', () => {
    it('blocked comment is marked blocked without affecting fixed/no-fix comments', async () => {
      const { deps, github, git, repo, agent } = makeBatchDeps(async () => ({
        ok: true,
        result: [
          { commentId: 9001, action: 'fixed', replyBody: 'Fixed 1' },
          { commentId: 9002, action: 'no_fix', replyBody: 'No fix needed' },
          {
            commentId: 9003,
            action: 'blocked',
            replyBody: 'Cannot fix',
            blockedReason: 'out of scope',
          },
        ],
      }));
      agent.clearQueue('post-pr-review-profile');
      agent.enqueue('post-pr-review-profile', () => {
        git.headByCwd.set('/work/tree', 'def456');
        return makeSuccessAgentResult();
      });
      git.remoteRefs.set('origin/feat-x', 'def456');
      git.ancestorResults.set('def456|def456', true);
      git.logBetweenResults.set('abc123|def456', ['def456']);

      const comments = [makeComment(9001), makeComment(9002), makeComment(9003)];
      const runner = new PollTaskRunner(deps);

      const result = await runner.executeBatch(makeBatchInput(comments));

      expect(result.retryDisposition).toBeUndefined();
      expect(git.pushes).toHaveLength(1);
      expect(github.repliesPosted).toHaveLength(3);

      const comment1 = repo.getComment(runId, 9001);
      const comment2 = repo.getComment(runId, 9002);
      const comment3 = repo.getComment(runId, 9003);

      expect(comment1?.state).toBe('processed');
      expect(comment2?.state).toBe('processed');
      expect(comment3?.state).toBe('blocked');
    });
  });

  describe('successful fixed results build once push once and verify every comment independently', () => {
    it('multiple fixed comments share one push but verify independently', async () => {
      const { deps, github, git, repo, agent } = makeBatchDeps(
        async () => ({
          ok: true,
          result: [
            { commentId: 9001, action: 'fixed', replyBody: 'Fixed 1' },
            { commentId: 9002, action: 'fixed', replyBody: 'Fixed 2' },
          ],
        }),
        {
          verifyBuildPasses: async () => ({ passed: true }),
        },
      );
      agent.clearQueue('post-pr-review-profile');
      agent.enqueue('post-pr-review-profile', () => {
        git.headByCwd.set('/work/tree', 'def456');
        return makeSuccessAgentResult();
      });
      git.remoteRefs.set('origin/feat-x', 'def456');
      git.ancestorResults.set('def456|def456', true);
      git.logBetweenResults.set('abc123|def456', ['def456']);

      const comments = [makeComment(9001), makeComment(9002)];
      const runner = new PollTaskRunner(deps);

      await runner.executeBatch(makeBatchInput(comments));

      expect(git.pushes).toHaveLength(1);
      expect(github.repliesPosted).toHaveLength(2);
      expect(github.resolvedThreads).toHaveLength(2);

      const comment1 = repo.getComment(runId, 9001);
      const comment2 = repo.getComment(runId, 9002);
      expect(comment1?.state).toBe('processed');
      expect(comment2?.state).toBe('processed');
    });

    it('one failed post-push reply verification leaves only that comment unverified', async () => {
      const { deps, git, agent } = makeBatchDeps(async () => ({
        ok: true,
        result: [
          { commentId: 9001, action: 'fixed', replyBody: 'Fixed 1' },
          { commentId: 9002, action: 'fixed', replyBody: 'Fixed 2' },
        ],
      }));
      agent.clearQueue('post-pr-review-profile');
      agent.enqueue('post-pr-review-profile', () => {
        git.headByCwd.set('/work/tree', 'def456');
        return makeSuccessAgentResult();
      });
      git.remoteRefs.set('origin/feat-x', 'def456');
      git.ancestorResults.set('def456|def456', true);
      git.logBetweenResults.set('abc123|def456', ['def456']);

      const comments = [makeComment(9001), makeComment(9002)];
      const runner = new PollTaskRunner(deps);

      const result = await runner.executeBatch(makeBatchInput(comments));

      const output1 = result.outputs.find((o) => o.commentId === 9001);
      const output2 = result.outputs.find((o) => o.commentId === 9002);

      expect(output1?.processed).toBe(true);
      expect(output2?.processed).toBe(true);
    });
  });

  describe('rollback failure is surfaced without marking any member processed', () => {
    it('reset failure does not mark any comment as processed', async () => {
      const comments = [makeComment(9001), makeComment(9002)];
      const { deps, github, git, repo, agent } = makeBatchDeps(
        async () => ({
          ok: true,
          result: [
            { commentId: 9001, action: 'fixed', replyBody: 'Fixed 1' },
            { commentId: 9002, action: 'fixed', replyBody: 'Fixed 2' },
          ],
        }),
        {
          verifyBuildPasses: async () => {
            throw new Error('Database connection lost');
          },
        },
      );
      comments.forEach((c) => repo.upsertComment(c));
      agent.clearQueue('post-pr-review-profile');
      agent.enqueue('post-pr-review-profile', () => {
        git.headByCwd.set('/work/tree', 'def456');
        return makeSuccessAgentResult();
      });

      const runner = new PollTaskRunner(deps);

      await expect(runner.executeBatch(makeBatchInput(comments))).rejects.toThrow(
        'Database connection lost',
      );

      expect(github.repliesPosted).toHaveLength(0);
      expect(git.pushes).toHaveLength(0);

      const comment1 = repo.getComment(runId, 9001);
      const comment2 = repo.getComment(runId, 9002);
      expect(comment1?.state).toBe('pending');
      expect(comment2?.state).toBe('pending');
    });
  });
});
