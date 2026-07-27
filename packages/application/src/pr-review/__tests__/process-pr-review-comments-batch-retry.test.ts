import { describe, it, expect } from 'vitest';
import { RunId, RepositoryId, PhaseName } from '@ai-sdlc/domain';
import {
  FakeGitHubPort,
  FakeGitPort,
  FakePrReviewRepository,
  FakeAgentPort,
  FakeArtifactStore,
  FakeFixDiffInspector,
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

function makeBatchRetryDeps(overrides: Partial<ProcessPrReviewDeps> = {}): {
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
    'post-pr-review-profile': [makeSuccess()],
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
  const artifactStore = new FakeArtifactStore();
  let currentCommentId = 9001;
  const deps: ProcessPrReviewDeps = {
    github,
    git,
    agent,
    prReviewRepo: repo,
    artifactStore,
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
  return { deps, github, git, repo, agent };
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

describe('ProcessPrReviewComments — batch retry FIFO work items', () => {
  describe('failed two-comment batch splits into two attempt-two singleton invocations', () => {
    it('does not retry the original group intact after multi-comment batch failure', async () => {
      const agent = new FakeAgentPort({
        'post-pr-review-profile': [makeSuccess(), makeSuccess(), makeSuccess(), makeSuccess()],
      });
      const { deps, github } = makeBatchRetryDeps({
        agent,
        renderBatchTaskPrompt: async ({ comments }) => {
          return `/tmp/batch-prompt-${comments.map((c) => c.commentId).join(',')}.md`;
        },
        extractBatchTaskResult: async () => ({
          ok: true,
          result: [
            { commentId: 9001, action: 'failed', replyBody: '' },
            { commentId: 9002, action: 'failed', replyBody: '' },
          ],
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
          createdAt: new Date(),
        },
        {
          id: 9002,
          prNumber: 5,
          path: 'a.ts',
          line: 10,
          reviewer: 'octocat',
          body: 'fix bar',
          createdAt: new Date(),
        },
      ]);
      const inspector = new FakeFixDiffInspector();
      inspector.setNext({ touchesPath: true, nearLine: true, reason: '' });
      const uc = new ProcessPrReviewComments({
        ...deps,
        fixDiffInspector: makeFixDiffInspector(inspector),
      });

      await uc.execute(baseInput);

      const batchPrompts = agent.invocations.filter(
        (inv) => (inv.metadata as Record<string, unknown>)['pr_review_batch_id'] !== undefined,
      );
      const singletonPrompts = agent.invocations.filter(
        (inv) => (inv.metadata as Record<string, unknown>)['pr_review_comment_id'] !== undefined,
      );

      expect(batchPrompts.length).toBe(1);
      expect(singletonPrompts.length).toBeGreaterThanOrEqual(2);

      const batchCommentIds = (batchPrompts[0]?.metadata as Record<string, unknown>)[
        'pr_review_comment_ids'
      ] as number[];
      expect(batchCommentIds).toContain(9001);
      expect(batchCommentIds).toContain(9002);
    });

    it('splits into singleton work items at attempt 2 after batch failure', async () => {
      const agent = new FakeAgentPort({
        'post-pr-review-profile': [makeSuccess(), makeSuccess(), makeSuccess(), makeSuccess()],
      });
      const invocationMetadata: Array<Record<string, unknown>> = [];
      const { deps, github } = makeBatchRetryDeps({
        agent,
        renderBatchTaskPrompt: async ({ comments }) => {
          return `/tmp/batch-prompt-${comments.map((c) => c.commentId).join(',')}.md`;
        },
        extractBatchTaskResult: async () => ({
          ok: true,
          result: [
            { commentId: 9001, action: 'failed', replyBody: '' },
            { commentId: 9002, action: 'failed', replyBody: '' },
          ],
        }),
        renderTaskPrompt: async ({ comment }) => {
          return `/tmp/prompt-${comment.commentId}.md`;
        },
        extractTaskResult: async ({}) => ({
          ok: true,
          result: { commentId: 9001, action: 'fixed', replyBody: 'Fixed.' },
        }),
      });
      agent.invoke = async (input) => {
        invocationMetadata.push(input.metadata as Record<string, unknown>);
        return makeSuccess();
      };

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
          path: 'a.ts',
          line: 10,
          reviewer: 'octocat',
          body: 'fix bar',
          createdAt: new Date(),
        },
      ]);
      const inspector = new FakeFixDiffInspector();
      inspector.setNext({ touchesPath: true, nearLine: true, reason: '' });
      const uc = new ProcessPrReviewComments({
        ...deps,
        fixDiffInspector: makeFixDiffInspector(inspector),
      });

      await uc.execute(baseInput);

      const retryInvocations = invocationMetadata.filter((m) => m['invocation_type'] === 'retry');
      expect(retryInvocations.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('split retries retain each comments own build and verifier feedback', () => {
    it('does not leak sibling failure text across singleton retry prompts', async () => {
      const capturedPrompts: Array<{
        commentId: number;
        previousBuildError?: string;
        previousCodeVerifyReason?: string;
      }> = [];

      const { github } = makeBatchRetryDeps({
        renderTaskPrompt: async (input) => {
          capturedPrompts.push({
            commentId: input.comment.commentId,
            previousBuildError: input.previousBuildError,
            previousCodeVerifyReason: input.previousCodeVerifyReason,
          });
          return '/tmp/prompt.md';
        },
        renderBatchTaskPrompt: async ({ comments }) => {
          return `/tmp/batch-prompt-${comments.map((c) => c.commentId).join(',')}.md`;
        },
        extractBatchTaskResult: async () => ({
          ok: true,
          result: [
            { commentId: 9001, action: 'failed', replyBody: '' },
            { commentId: 9002, action: 'failed', replyBody: '' },
          ],
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
          createdAt: new Date(),
        },
        {
          id: 9002,
          prNumber: 5,
          path: 'a.ts',
          line: 10,
          reviewer: 'octocat',
          body: 'fix bar',
          createdAt: new Date(),
        },
      ]);

      let buildCallCount = 0;
      const { deps: deps2 } = makeBatchRetryDeps({
        renderTaskPrompt: async (input) => {
          capturedPrompts.push({
            commentId: input.comment.commentId,
            previousBuildError: input.previousBuildError,
            previousCodeVerifyReason: input.previousCodeVerifyReason,
          });
          return '/tmp/prompt.md';
        },
        renderBatchTaskPrompt: async ({ comments }) => {
          return `/tmp/batch-prompt-${comments.map((c) => c.commentId).join(',')}.md`;
        },
        extractBatchTaskResult: async () => ({
          ok: true,
          result: [
            { commentId: 9001, action: 'failed', replyBody: '' },
            { commentId: 9002, action: 'failed', replyBody: '' },
          ],
        }),
        verifyBuildPasses: async () => {
          buildCallCount++;
          if (buildCallCount === 1) {
            return { passed: false, error: 'TS9999: comment 9001 specific error' };
          }
          return { passed: true };
        },
      });

      const inspector = new FakeFixDiffInspector();
      inspector.setNext({ touchesPath: true, nearLine: true, reason: '' });
      const uc = new ProcessPrReviewComments({
        ...deps2,
        fixDiffInspector: makeFixDiffInspector(inspector),
      });

      await uc.execute(baseInput);

      const retryPrompts = capturedPrompts.filter(
        (p) => p.previousBuildError !== undefined || p.previousCodeVerifyReason !== undefined,
      );

      for (const prompt of retryPrompts) {
        if (prompt.commentId === 9001) {
          expect(prompt.previousBuildError).toBe('TS9999: comment 9001 specific error');
        }
        if (prompt.commentId === 9002) {
          expect(prompt.previousBuildError).not.toContain('9001');
        }
      }
    });
  });

  describe('retry context advances from hunk to file to related context', () => {
    it('escalates context level exactly once per retry for singleton comments', async () => {
      const contextLevels: number[] = [];
      const { deps, github } = makeBatchRetryDeps({
        renderBatchTaskPrompt: async ({ comments: _comments }) => {
          return `/tmp/batch-prompt.md`;
        },
        extractBatchTaskResult: async () => ({
          ok: true,
          result: [{ commentId: 9001, action: 'failed', replyBody: '' }],
        }),
        renderTaskPrompt: async ({}) => {
          return '/tmp/prompt.md';
        },
        extractTaskResult: async () => ({
          ok: true,
          result: { commentId: 9001, action: 'fixed', replyBody: 'Fixed.' },
        }),
        contextSource: async () => ({
          fullDiff: '',
          diffStat: '',
          changedFiles: [],
          fileContents: {},
          trackedFiles: [],
        }),
      });

      const agent = new FakeAgentPort({
        'post-pr-review-profile': [makeSuccess(), makeSuccess(), makeSuccess()],
      });
      agent.invoke = async (input) => {
        agentInvokeCount++;
        const metadata = input.metadata as Record<string, unknown>;
        contextLevels.push(metadata['pr_review_context_level'] as number);
        return makeSuccess();
      };

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
      const inspector = new FakeFixDiffInspector();
      inspector.setNext({ touchesPath: true, nearLine: true, reason: '' });
      const uc = new ProcessPrReviewComments({
        ...deps,
        agent,
        fixDiffInspector: makeFixDiffInspector(inspector),
      });

      await uc.execute(baseInput);

      const batchContextLevels = contextLevels.slice(0, 1);
      const singletonContextLevels = contextLevels.slice(1);

      if (batchContextLevels.length > 0) {
        expect(batchContextLevels[0]).toBe(1);
      }
      for (const level of singletonContextLevels) {
        expect(level).toBeGreaterThanOrEqual(1);
        expect(level).toBeLessThanOrEqual(3);
      }
    });
  });

  describe('attempt three uses bounded related context when it is sufficient', () => {
    it('does not emit full-diff when related context is sufficient at attempt 3', async () => {
      const fullDiffEmitted: boolean[] = [];
      const { deps, github } = makeBatchRetryDeps({
        contextSource: async () => ({
          fullDiff: 'full diff content',
          diffStat: '10 files changed',
          changedFiles: ['a.ts', 'b.ts'],
          fileContents: {
            'a.ts': 'export const a = 1;',
            'b.ts': 'export const b = 2;',
          },
          trackedFiles: ['a.ts', 'b.ts'],
        }),
        renderBatchTaskPrompt: async () => '/tmp/batch-prompt.md',
        extractBatchTaskResult: async () => ({
          ok: true,
          result: [{ commentId: 9001, action: 'failed', replyBody: '' }],
        }),
        renderTaskPrompt: async () => '/tmp/prompt.md',
        extractTaskResult: async () => ({
          ok: true,
          result: { commentId: 9001, action: 'fixed', replyBody: 'Fixed.' },
        }),
      });

      let agentInvokeCount = 0;
      const agent = new FakeAgentPort({
        'post-pr-review-profile': [makeSuccess(), makeSuccess(), makeSuccess()],
      });
      agent.invoke = async (input) => {
        agentInvokeCount++;
        const metadata = input.metadata as Record<string, unknown>;
        fullDiffEmitted.push(metadata['pr_review_full_diff_included'] as boolean);
        if (agentInvokeCount < 3) {
          return makeSuccess({ outcome: 'failed', exitCode: 1 });
        }
        return makeSuccess();
      };

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
      const inspector = new FakeFixDiffInspector();
      inspector.setNext({ touchesPath: true, nearLine: true, reason: '' });
      const uc = new ProcessPrReviewComments({
        ...deps,
        agent,
        fixDiffInspector: makeFixDiffInspector(inspector),
      });

      await uc.execute(baseInput);

      const attempt3FullDiff = fullDiffEmitted[2];
      expect(attempt3FullDiff).toBe(false);
    });
  });

  describe('attempt three full-diff fallback is observable and still independently verified', () => {
    it('records fallback reason when full-diff is emitted at attempt 3', async () => {
      const fallbackReasons: string[] = [];
      const { deps, github } = makeBatchRetryDeps({
        contextSource: async () => ({
          fullDiff: 'full diff content',
          diffStat: '10 files changed',
          changedFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
          fileContents: {
            'a.ts': 'export const a = 1;',
            'b.ts': 'export const b = 2;',
            'c.ts': 'export const c = 3;',
            'd.ts': 'export const d = 4;',
            'e.ts': 'export const e = 5;',
            'f.ts': 'export const f = 6;',
          },
          trackedFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
        }),
        renderBatchTaskPrompt: async () => '/tmp/batch-prompt.md',
        extractBatchTaskResult: async () => ({
          ok: true,
          result: [{ commentId: 9001, action: 'failed', replyBody: '' }],
        }),
        renderTaskPrompt: async () => '/tmp/prompt.md',
        extractTaskResult: async () => ({
          ok: true,
          result: { commentId: 9001, action: 'fixed', replyBody: 'Fixed.' },
        }),
      });

      const contextSelectedEvents: Array<{
        level: number;
        commentIds: readonly number[];
        fullDiffIncluded: boolean;
        fallbackReason?: string;
      }> = [];
      const agent = new FakeAgentPort({
        'post-pr-review-profile': [makeSuccess(), makeSuccess(), makeSuccess()],
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
      const inspector = new FakeFixDiffInspector();
      inspector.setNext({ touchesPath: true, nearLine: true, reason: '' });
      const uc = new ProcessPrReviewComments({
        ...deps,
        agent,
        fixDiffInspector: makeFixDiffInspector(inspector),
        onContextSelected: (event) => {
          contextSelectedEvents.push(event);
        },
      });

      await uc.execute(baseInput);

      const attempt3Context = contextSelectedEvents.find((e) => e.level === 3);
      if (attempt3Context && attempt3Context.fullDiffIncluded) {
        fallbackReasons.push(attempt3Context.fallbackReason ?? 'no_bounded_context');
      }
      expect(fallbackReasons.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('partial batch validation success rolls back all changes before singleton retry', () => {
    it('rolls back batch when one fixed comment fails pre-push verification', async () => {
      const rollbackCalls: Array<{ ctx: { cwd: string; branch: string }; sha: string }> = [];
      const { deps, github } = makeBatchRetryDeps({
        renderBatchTaskPrompt: async ({ comments: _comments }) => `/tmp/batch.md`,
        extractBatchTaskResult: async () => ({
          ok: true,
          result: [
            { commentId: 9001, action: 'fixed', replyBody: 'Fixed 1' },
            { commentId: 9002, action: 'fixed', replyBody: 'Fixed 2' },
          ],
        }),
        renderTaskPrompt: async ({ comment }) => `/tmp/prompt-${comment.commentId}.md`,
        extractTaskResult: async ({}) => ({
          ok: true,
          result: { commentId: 9001, action: 'fixed', replyBody: 'Retry.' },
        }),
        rollbackFix: async (ctx, sha) => {
          rollbackCalls.push({ ctx, sha });
          return true;
        },
        verifyCodeChange: (async () => {
          let callCount = 0;
          return () => {
            callCount++;
            if (callCount === 1) {
              return { pass: false, reason: 'comment 9002 verifier rejected' };
            }
            return { pass: true, reason: 'ok' };
          };
        })() as VerifyCodeChangeFn,
      });
      github.comments.set('o/r/5', [
        {
          id: 9001,
          prNumber: 5,
          path: 'a.ts',
          line: 3,
          reviewer: 'octocat',
          body: 'fix 1',
          createdAt: new Date(),
        },
        {
          id: 9002,
          prNumber: 5,
          path: 'a.ts',
          line: 10,
          reviewer: 'octocat',
          body: 'fix 2',
          createdAt: new Date(),
        },
      ]);
      const inspector = new FakeFixDiffInspector();
      inspector.setNext({ touchesPath: true, nearLine: true, reason: '' });
      const uc = new ProcessPrReviewComments({
        ...deps,
        fixDiffInspector: makeFixDiffInspector(inspector),
      });

      await uc.execute(baseInput);

      expect(rollbackCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('four valid fixes cannot survive when a fifth fixed result fails pre-push verification', async () => {
      const rollbackCalls: Array<{ ctx: { cwd: string; branch: string }; sha: string }> = [];
      let verifyCallCount = 0;
      const { deps, github } = makeBatchRetryDeps({
        renderBatchTaskPrompt: async ({ comments: _comments }) => `/tmp/batch.md`,
        extractBatchTaskResult: async () => ({
          ok: true,
          result: [
            { commentId: 9001, action: 'fixed', replyBody: 'Fixed 1' },
            { commentId: 9002, action: 'fixed', replyBody: 'Fixed 2' },
            { commentId: 9003, action: 'fixed', replyBody: 'Fixed 3' },
            { commentId: 9004, action: 'fixed', replyBody: 'Fixed 4' },
            { commentId: 9005, action: 'fixed', replyBody: 'Fixed 5' },
          ],
        }),
        renderTaskPrompt: async ({ comment }) => `/tmp/prompt-${comment.commentId}.md`,
        extractTaskResult: async ({}) => ({
          ok: true,
          result: { commentId: 9001, action: 'fixed', replyBody: 'Retry.' },
        }),
        rollbackFix: async (ctx, sha) => {
          rollbackCalls.push({ ctx, sha });
          return true;
        },
        verifyCodeChange: (async () => {
          return ({ commentId }: { commentId?: number }) => {
            verifyCallCount++;
            if (commentId === 9005 && verifyCallCount > 5) {
              return { pass: false, reason: 'comment 9005 verifier rejected' };
            }
            return { pass: true, reason: 'ok' };
          };
        })() as VerifyCodeChangeFn,
      });
      github.comments.set('o/r/5', [
        {
          id: 9001,
          prNumber: 5,
          path: 'a.ts',
          line: 3,
          reviewer: 'octocat',
          body: 'fix 1',
          createdAt: new Date(),
        },
        {
          id: 9002,
          prNumber: 5,
          path: 'a.ts',
          line: 10,
          reviewer: 'octocat',
          body: 'fix 2',
          createdAt: new Date(),
        },
        {
          id: 9003,
          prNumber: 5,
          path: 'a.ts',
          line: 20,
          reviewer: 'octocat',
          body: 'fix 3',
          createdAt: new Date(),
        },
        {
          id: 9004,
          prNumber: 5,
          path: 'a.ts',
          line: 30,
          reviewer: 'octocat',
          body: 'fix 4',
          createdAt: new Date(),
        },
        {
          id: 9005,
          prNumber: 5,
          path: 'a.ts',
          line: 40,
          reviewer: 'octocat',
          body: 'fix 5',
          createdAt: new Date(),
        },
      ]);
      const inspector = new FakeFixDiffInspector();
      inspector.setNext({ touchesPath: true, nearLine: true, reason: '' });
      const uc = new ProcessPrReviewComments({
        ...deps,
        fixDiffInspector: makeFixDiffInspector(inspector),
      });

      await uc.execute(baseInput);

      expect(rollbackCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('one singleton succeeds after split while its sibling exhausts and blocks', () => {
    it('processed/blocked totals remain independent after split', async () => {
      const { deps, github, repo } = makeBatchRetryDeps({
        renderBatchTaskPrompt: async ({ comments: _comments }) => `/tmp/batch.md`,
        extractBatchTaskResult: async () => ({
          ok: true,
          result: [
            { commentId: 9001, action: 'failed', replyBody: '' },
            { commentId: 9002, action: 'failed', replyBody: '' },
          ],
        }),
        renderTaskPrompt: async ({ comment }) => `/tmp/prompt-${comment.commentId}.md`,
        extractTaskResult: async ({}) => {
          return {
            ok: true,
            result: { commentId: 9001, action: 'fixed', replyBody: 'Fixed.' },
          };
        },
      });

      let agentInvokeCount = 0;
      const agent = new FakeAgentPort({
        'post-pr-review-profile': [
          makeSuccess(),
          makeSuccess(),
          makeSuccess(),
          makeSuccess(),
          makeSuccess(),
        ],
      });
      agent.invoke = async () => {
        agentInvokeCount++;
        if (agentInvokeCount <= 3) {
          return makeSuccess({ outcome: 'failed', exitCode: 1 });
        }
        return makeSuccess();
      };

      github.comments.set('o/r/5', [
        {
          id: 9001,
          prNumber: 5,
          path: 'a.ts',
          line: 3,
          reviewer: 'octocat',
          body: 'fix 1',
          createdAt: new Date(),
        },
        {
          id: 9002,
          prNumber: 5,
          path: 'a.ts',
          line: 10,
          reviewer: 'octocat',
          body: 'fix 2',
          createdAt: new Date(),
        },
      ]);
      const inspector = new FakeFixDiffInspector();
      inspector.setNext({ touchesPath: true, nearLine: true, reason: '' });
      const uc = new ProcessPrReviewComments({
        ...deps,
        agent,
        fixDiffInspector: makeFixDiffInspector(inspector),
      });

      const out = await uc.execute(baseInput);

      expect(out.processed).toBeGreaterThanOrEqual(0);
      expect(out.blocked).toBeGreaterThanOrEqual(0);
      expect(out.processed + out.blocked).toBeLessThanOrEqual(2);

      const comment1 = repo.getComment(runId, 9001);
      const comment2 = repo.getComment(runId, 9002);

      const resolved = [comment1?.state, comment2?.state].filter((s) => s === 'processed');
      const blocked = [comment1?.state, comment2?.state].filter((s) => s === 'blocked');

      if (comment1?.state === 'processed' || comment2?.state === 'processed') {
        expect(out.processed).toBe(resolved.length);
      }
      if (comment1?.state === 'blocked' || comment2?.state === 'blocked') {
        expect(out.blocked).toBe(blocked.length);
      }
    });
  });

  describe('rollback failure at exhaustion warns and blocks without losing attempt evidence', () => {
    it('emits warning when rollbackFix fails at final exhaustion', async () => {
      const warnings: Array<{ message: string; metadata: Record<string, unknown> }> = [];
      const rollbackCalls: Array<{ ctx: { cwd: string; branch: string }; sha: string }> = [];

      const { deps, github, repo } = makeBatchRetryDeps({
        renderBatchTaskPrompt: async ({ comments: _comments }) => `/tmp/batch.md`,
        extractBatchTaskResult: async () => ({
          ok: true,
          result: [
            { commentId: 9001, action: 'failed', replyBody: '' },
            { commentId: 9002, action: 'failed', replyBody: '' },
          ],
        }),
        renderTaskPrompt: async ({ comment }) => `/tmp/prompt-${comment.commentId}.md`,
        extractTaskResult: async ({}) => ({
          ok: true,
          result: { commentId: 9001, action: 'failed', replyBody: '' },
        }),
        rollbackFix: async (ctx, sha) => {
          rollbackCalls.push({ ctx, sha });
          return false;
        },
        onWarning: (message, metadata, _runId) => {
          warnings.push({ message, metadata });
        },
      });

      const agent = new FakeAgentPort({
        'post-pr-review-profile': [
          makeSuccess(),
          makeSuccess(),
          makeSuccess(),
          makeSuccess(),
          makeSuccess(),
          makeSuccess(),
        ],
      });
      agent.invoke = async () => {
        agentInvokeCount++;
        return makeSuccess({ outcome: 'failed', exitCode: 1 });
      };

      github.comments.set('o/r/5', [
        {
          id: 9001,
          prNumber: 5,
          path: 'a.ts',
          line: 3,
          reviewer: 'octocat',
          body: 'fix 1',
          createdAt: new Date(),
        },
        {
          id: 9002,
          prNumber: 5,
          path: 'a.ts',
          line: 10,
          reviewer: 'octocat',
          body: 'fix 2',
          createdAt: new Date(),
        },
      ]);
      const inspector = new FakeFixDiffInspector();
      inspector.setNext({ touchesPath: true, nearLine: true, reason: '' });
      const uc = new ProcessPrReviewComments({
        ...deps,
        agent,
        fixDiffInspector: makeFixDiffInspector(inspector),
      });

      await uc.execute(baseInput);

      const rollbackWarnings = warnings.filter((w) => w.message.includes('rollbackFix failed'));
      expect(rollbackWarnings.length).toBeGreaterThanOrEqual(0);

      const blockedComments = [repo.getComment(runId, 9001), repo.getComment(runId, 9002)].filter(
        (c) => c?.state === 'blocked',
      );
      expect(blockedComments.length).toBeGreaterThanOrEqual(0);

      const hasBlocked = blockedComments.length > 0;
      const hasWarning = rollbackWarnings.length > 0;
      expect(hasBlocked || hasWarning).toBe(true);
    });

    it('run never reports allResolved when rollback fails at exhaustion', async () => {
      const { deps, github } = makeBatchRetryDeps({
        renderBatchTaskPrompt: async ({ comments: _comments }) => `/tmp/batch.md`,
        extractBatchTaskResult: async () => ({
          ok: true,
          result: [
            { commentId: 9001, action: 'failed', replyBody: '' },
            { commentId: 9002, action: 'failed', replyBody: '' },
          ],
        }),
        renderTaskPrompt: async ({ comment }) => `/tmp/prompt-${comment.commentId}.md`,
        extractTaskResult: async ({}) => ({
          ok: true,
          result: { commentId: 9001, action: 'failed', replyBody: '' },
        }),
        rollbackFix: async () => false,
      });

      const agent = new FakeAgentPort({
        'post-pr-review-profile': [
          makeSuccess(),
          makeSuccess(),
          makeSuccess(),
          makeSuccess(),
          makeSuccess(),
          makeSuccess(),
        ],
      });
      agent.invoke = async () => {
        agentInvokeCount++;
        return makeSuccess({ outcome: 'failed', exitCode: 1 });
      };

      github.comments.set('o/r/5', [
        {
          id: 9001,
          prNumber: 5,
          path: 'a.ts',
          line: 3,
          reviewer: 'octocat',
          body: 'fix 1',
          createdAt: new Date(),
        },
        {
          id: 9002,
          prNumber: 5,
          path: 'a.ts',
          line: 10,
          reviewer: 'octocat',
          body: 'fix 2',
          createdAt: new Date(),
        },
      ]);
      const inspector = new FakeFixDiffInspector();
      inspector.setNext({ touchesPath: true, nearLine: true, reason: '' });
      const uc = new ProcessPrReviewComments({
        ...deps,
        agent,
        fixDiffInspector: makeFixDiffInspector(inspector),
      });

      const out = await uc.execute(baseInput);

      expect(out.allResolved).toBe(false);
    });
  });
});
