import { describe, it, expect, vi } from 'vitest';
import { RunId, RepositoryId, PhaseName, createPrReviewComment } from '@ai-sdlc/domain';
import type { PrReviewComment, PrReviewReply } from '@ai-sdlc/domain';
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

interface BatchValidationDeps {
  deps: PollTaskRunnerDeps;
  github: FakeGitHubPort;
  git: FakeGitPort;
  repo: RecordingPrReviewRepository;
  agent: FakeAgentPort;
}

function makeBatchValidationDeps(
  batchExtractResult?: (input: {
    resultJsonPath?: string;
    cwd: string;
  }) => Promise<
    { ok: true; result: PollTaskBatchResultEntry[] } | { ok: false; reason: string; detail: string }
  >,
  overrides: Partial<PollTaskRunnerDeps> = {},
): BatchValidationDeps {
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

describe('PollTaskRunner batch — side-effect-order validation tests', () => {
  describe('reply and resolution order', () => {
    it('replies are posted in stable comment order before resolution', async () => {
      const { deps, repo, git, agent } = makeBatchValidationDeps(async () => ({
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

      const replyIndices = comments.map((c) => {
        const idx = repo.operations.indexOf(`insertReply:${c.commentId}`);
        return idx;
      });
      expect(replyIndices[0]).toBeLessThan(replyIndices[1]);

      const processedIndices = comments.map((c) => {
        const idx = repo.operations.indexOf(`upsertComment:processed:${c.commentId}`);
        return idx;
      });
      expect(processedIndices[0]).toBeLessThan(processedIndices[1]);
    });

    it('no-op rollback does not insert replies on failure', async () => {
      const { deps, repo, git, agent } = makeBatchValidationDeps(
        async () => ({
          ok: true,
          result: [
            { commentId: 9001, action: 'fixed', replyBody: 'Fixed 1' },
            { commentId: 9002, action: 'fixed', replyBody: 'Fixed 2' },
          ],
        }),
        {
          verifyBuildPasses: async () => ({ passed: false, error: 'build failed' }),
        },
      );
      agent.clearQueue('post-pr-review-profile');
      agent.enqueue('post-pr-review-profile', () => {
        git.headByCwd.set('/work/tree', 'def456');
        return makeSuccessAgentResult();
      });

      const comments = [makeComment(9001), makeComment(9002)];
      const runner = new PollTaskRunner(deps);

      await runner.executeBatch(makeBatchInput(comments));

      const replyOps = repo.operations.filter((op) => op.startsWith('insertReply'));
      expect(replyOps).toHaveLength(0);
    });
  });

  describe('attempt record completeness', () => {
    it('all attempts share the same prompt/result path and batch ID', async () => {
      const { deps, repo, git, agent } = makeBatchValidationDeps(async () => ({
        ok: true,
        result: [
          { commentId: 9001, action: 'fixed', replyBody: 'Fixed 1' },
          { commentId: 9002, action: 'no_fix', replyBody: 'No fix needed' },
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

      const attempts1 = repo.listCommentAttempts(runId, 9001);
      const attempts2 = repo.listCommentAttempts(runId, 9002);

      expect(attempts1[0].promptPath).toBe(attempts2[0].promptPath);
      expect(attempts1[0].resultArtifactPath).toBe(attempts2[0].resultArtifactPath);
      expect(attempts1[0].batchId).toBe(attempts2[0].batchId);
      expect(attempts1[0].batchId).toBeDefined();
    });

    it('each attempt has a distinct attemptId', async () => {
      const { deps, repo, git, agent } = makeBatchValidationDeps(async () => ({
        ok: true,
        result: [
          { commentId: 9001, action: 'fixed', replyBody: 'Fixed 1' },
          { commentId: 9002, action: 'no_fix', replyBody: 'No fix 2' },
          { commentId: 9003, action: 'blocked', replyBody: 'Blocked 3', blockedReason: 'scope' },
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

      await runner.executeBatch(makeBatchInput(comments));

      const attemptIds = [9001, 9002, 9003].map((cid) => {
        const attempts = repo.listCommentAttempts(runId, cid);
        return attempts[0].attemptId;
      });

      const uniqueIds = new Set(attemptIds);
      expect(uniqueIds.size).toBe(3);
    });
  });

  describe('invocation metadata', () => {
    it('sets pr_review_batch_id, pr_review_comment_ids, pr_review_comment_count in metadata', async () => {
      const { deps, agent } = makeBatchValidationDeps();
      const comments = [makeComment(9001), makeComment(9002), makeComment(9003)];
      const runner = new PollTaskRunner(deps);

      await runner.executeBatch(makeBatchInput(comments));

      expect(agent.invocations[0].metadata).toMatchObject({
        pr_review_batch_id: expect.any(String),
        pr_review_comment_ids: [9001, 9002, 9003],
        pr_review_comment_count: 3,
      });
    });

    it('sets pr_review_context_level and pr_review_context_files when provided', async () => {
      const { deps, agent } = makeBatchValidationDeps();
      const comments = [makeComment(9001), makeComment(9002)];
      const runner = new PollTaskRunner(deps);

      await runner.executeBatch(
        makeBatchInput(comments, {
          contextLevel: 2,
          contextFiles: ['src/a.ts', 'src/b.ts'],
          fullDiffIncluded: true,
        }),
      );

      expect(agent.invocations[0].metadata).toMatchObject({
        pr_review_context_level: 2,
        pr_review_context_files: ['src/a.ts', 'src/b.ts'],
        pr_review_full_diff_included: true,
      });
    });
  });

  describe('atomic pre-push gate', () => {
    it('blocks all replies until all pre-push checks pass', async () => {
      const { deps, github, git, agent } = makeBatchValidationDeps(async () => ({
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

      expect(github.repliesPosted).toHaveLength(2);
      expect(git.pushes).toHaveLength(1);
    });

    it('does not post replies when verifier fails', async () => {
      const { deps, github, git, agent } = makeBatchValidationDeps(
        async () => ({
          ok: true,
          result: [
            { commentId: 9001, action: 'fixed', replyBody: 'Fixed 1' },
            { commentId: 9002, action: 'fixed', replyBody: 'Fixed 2' },
          ],
        }),
        {
          verifyCodeChange: async () => ({ pass: false, reason: 'bad change' }),
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

      expect(github.repliesPosted).toHaveLength(0);
      expect(git.pushes).toHaveLength(0);
    });
  });

  describe('timeout scaling', () => {
    it('computes timeoutMs using min(30, 10 + 5 * N) * 60_000 formula for batch', async () => {
      const { deps, agent } = makeBatchValidationDeps();
      const comments = [makeComment(9001), makeComment(9002), makeComment(9003)];
      const runner = new PollTaskRunner(deps);

      await runner.executeBatch(
        makeBatchInput(comments, {
          unresolvedCommentCount: 3,
        }),
      );

      expect(agent.invocations).toHaveLength(1);
      expect(agent.invocations[0].timeoutMs).toBe(1_500_000);
    });

    it('caps timeout at 30 minutes for large batch sizes', async () => {
      const { deps, agent } = makeBatchValidationDeps();
      const comments = Array.from({ length: 5 }, (_, i) => makeComment(9001 + i));
      const runner = new PollTaskRunner(deps);

      await runner.executeBatch(
        makeBatchInput(comments, {
          unresolvedCommentCount: 10,
        }),
      );

      expect(agent.invocations[0].timeoutMs).toBe(1_800_000);
    });
  });

  describe('retryDisposition behavior', () => {
    it('returns split disposition when batch has multiple comments and fails', async () => {
      const { deps, git, agent } = makeBatchValidationDeps(
        async () => ({
          ok: true,
          result: [
            { commentId: 9001, action: 'fixed', replyBody: 'Fixed 1' },
            { commentId: 9002, action: 'fixed', replyBody: 'Fixed 2' },
          ],
        }),
        {
          verifyBuildPasses: async () => ({ passed: false, error: 'build broke' }),
        },
      );
      agent.clearQueue('post-pr-review-profile');
      agent.enqueue('post-pr-review-profile', () => {
        git.headByCwd.set('/work/tree', 'def456');
        return makeSuccessAgentResult();
      });

      const comments = [makeComment(9001), makeComment(9002)];
      const runner = new PollTaskRunner(deps);

      const result = await runner.executeBatch(makeBatchInput(comments));

      expect(result.retryDisposition).toBe('split');
    });

    it('does not return split disposition for successful batch', async () => {
      const { deps, git, agent } = makeBatchValidationDeps(async () => ({
        ok: true,
        result: [
          { commentId: 9001, action: 'fixed', replyBody: 'Fixed 1' },
          { commentId: 9002, action: 'no_fix', replyBody: 'No fix needed' },
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

      expect(result.retryDisposition).toBeUndefined();
    });
  });

  describe('stable comment order for replies and resolutions', () => {
    it('processes comments in input order', async () => {
      const { deps, git, agent } = makeBatchValidationDeps(async () => ({
        ok: true,
        result: [
          { commentId: 9003, action: 'no_fix', replyBody: 'No fix 3' },
          { commentId: 9001, action: 'fixed', replyBody: 'Fixed 1' },
          { commentId: 9002, action: 'blocked', replyBody: 'Blocked 2', blockedReason: 'scope' },
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

      const comments = [makeComment(9003), makeComment(9001), makeComment(9002)];
      const runner = new PollTaskRunner(deps);

      const result = await runner.executeBatch(makeBatchInput(comments));

      const outputOrder = result.outputs.map((o) => o.commentId);
      expect(outputOrder).toEqual([9001, 9002, 9003]);
    });
  });

  describe('verification invocation counts', () => {
    it('tracks verifyBuildPasses and verifyCodeChange invocation counts for successful batch', async () => {
      const verifyBuildPassesSpy = vi.fn(async () => ({ passed: true }));
      const verifyCodeChangeSpy = vi.fn(async () => ({ pass: true }));
      const { deps, git, agent } = makeBatchValidationDeps(
        async () => ({
          ok: true,
          result: [
            { commentId: 9001, action: 'fixed', replyBody: 'Fixed 1' },
            { commentId: 9002, action: 'fixed', replyBody: 'Fixed 2' },
          ],
        }),
        {
          verifyBuildPasses: verifyBuildPassesSpy,
          verifyCodeChange: verifyCodeChangeSpy,
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

      expect(verifyBuildPassesSpy).toHaveBeenCalledTimes(3);
      expect(verifyCodeChangeSpy).toHaveBeenCalledTimes(4);
    });
  });
});
